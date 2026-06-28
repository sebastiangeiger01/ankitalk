/**
 * Durable TTS audio cache on R2.
 *
 * The hot path stays the Cloudflare edge cache; R2 sits *behind* it as the persistent layer so a
 * given `(text + voice + settings)` hash is paid for at the speech provider exactly once instead
 * of being regenerated on every edge eviction (every ~24h, or whenever a request lands on a
 * different edge colo).
 *
 * Retention is driven entirely by R2's native object-lifecycle rules — no cron job, no sweeper —
 * using two key prefixes that the bucket lifecycle config treats differently:
 *
 *   - `tts/std/<hash>`  unpinned audio   → lifecycle rule: delete ~STD_RETENTION_DAYS after write
 *   - `tts/pin/<hash>`  exam-pinned audio → lifecycle rule: delete ~PIN_RETENTION_DAYS after write
 *
 * R2 lifecycle expires objects by *age since they were written*, not by last access. To turn that
 * into idle-based expiry (and to honour exam pins), {@link refreshStoredAudio} re-puts an object
 * on access when it nears expiry — resetting its clock without ever calling the speech provider.
 * A card replayed within the window therefore survives; one abandoned for a whole window expires.
 *
 * The two bucket lifecycle rules are a one-time manual configuration per bucket (see the PR /
 * migrations notes); nothing here creates them.
 */

const STD_PREFIX = 'tts/std/';
const PIN_PREFIX = 'tts/pin/';

/** Idle window for unpinned audio. The bucket's `tts/std/` lifecycle rule must match this. */
export const STD_RETENTION_DAYS = 30;
/** Ceiling for exam-pinned audio. The bucket's `tts/pin/` lifecycle rule must match this. */
export const PIN_RETENTION_DAYS = 180;

/**
 * Only reset an object's lifecycle clock once it's older than this. Avoids rewriting a popular
 * clip on every single play while still keeping anything replayed within the window resident.
 */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const AUDIO_CONTENT_TYPE = 'audio/mpeg';
const AUDIO_CACHE_CONTROL = 'public, max-age=86400';

/** Headers for an audio response built from buffered bytes (edge-cacheable for 24h). */
export const AUDIO_RESPONSE_HEADERS = {
	'Content-Type': AUDIO_CONTENT_TYPE,
	'Cache-Control': AUDIO_CACHE_CONTROL
} as const;

function isMissingSchemaError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return (
		message.includes('no such table') ||
		message.includes('no such column') ||
		message.includes('no column named')
	);
}

/** SHA-256 hex of the cache payload — the stable identity of one synthesized clip. */
export async function ttsHash(payload: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function keyFor(hash: string, pinned: boolean): string {
	return (pinned ? PIN_PREFIX : STD_PREFIX) + hash;
}

export interface StoredAudio {
	bytes: ArrayBuffer;
	contentType: string;
	uploadedMs: number;
	/** Which prefix the object was found under (true = the long-retention pin prefix). */
	pinned: boolean;
}

/**
 * Look up cached audio, checking the prefix that matches the deck's *current* pin status first
 * but falling back to the other prefix — audio is often generated before a deck is pinned (or
 * after a pin lapses), and we still want to reuse it rather than pay to regenerate.
 */
export async function getStoredAudio(
	bucket: R2Bucket,
	hash: string,
	preferPinned: boolean
): Promise<StoredAudio | null> {
	const order = preferPinned ? [true, false] : [false, true];
	for (const pinned of order) {
		const obj = await bucket.get(keyFor(hash, pinned));
		if (obj) {
			return {
				bytes: await obj.arrayBuffer(),
				contentType: obj.httpMetadata?.contentType ?? AUDIO_CONTENT_TYPE,
				uploadedMs: obj.uploaded.getTime(),
				pinned
			};
		}
	}
	return null;
}

/** Persist freshly synthesized (or migrated) audio under the prefix matching its pin status. */
export async function putStoredAudio(
	bucket: R2Bucket,
	hash: string,
	bytes: ArrayBuffer,
	pinned: boolean,
	contentType: string = AUDIO_CONTENT_TYPE
): Promise<void> {
	await bucket.put(keyFor(hash, pinned), bytes, {
		httpMetadata: { contentType, cacheControl: AUDIO_CACHE_CONTROL }
	});
}

/**
 * Keep a cache hit alive correctly. If the object is in the wrong prefix for the deck's current
 * pin status, migrate it (write the correct prefix, delete the old). Otherwise reset its
 * lifecycle clock only once it's old enough to be nearing expiry. Never calls the speech provider.
 *
 * Returns `true` when it actually re-wrote the object, so the caller can bump the matching
 * `tts_audio` index row's expiry in lock-step with the R2 lifecycle clock.
 */
export async function refreshStoredAudio(
	bucket: R2Bucket,
	hash: string,
	stored: StoredAudio,
	shouldBePinned: boolean
): Promise<boolean> {
	if (stored.pinned !== shouldBePinned) {
		await putStoredAudio(bucket, hash, stored.bytes, shouldBePinned, stored.contentType);
		await bucket.delete(keyFor(hash, stored.pinned));
		return true;
	}
	if (Date.now() - stored.uploadedMs > REFRESH_AFTER_MS) {
		await putStoredAudio(bucket, hash, stored.bytes, shouldBePinned, stored.contentType);
		return true;
	}
	return false;
}

/**
 * Best-effort generation lock so two near-simultaneous first plays of the same clip don't both
 * call the (paid) speech provider. KV has no atomic compare-and-set, so this narrows the race
 * window rather than closing it completely; the caller re-checks R2 after a short wait.
 */
function lockKey(hash: string): string {
	return `ttslock:${hash}`;
}
export async function isGenerationLocked(kv: KVNamespace, hash: string): Promise<boolean> {
	return (await kv.get(lockKey(hash))) !== null;
}
export async function acquireGenerationLock(kv: KVNamespace, hash: string): Promise<void> {
	await kv.put(lockKey(hash), '1', { expirationTtl: 60 });
}
export async function releaseGenerationLock(kv: KVNamespace, hash: string): Promise<void> {
	await kv.delete(lockKey(hash));
}

/** True while the deck carries a future `audio_keep_until` date (an active exam pin). */
export async function isDeckAudioPinned(
	db: D1Database,
	userId: string,
	deckId: string
): Promise<boolean> {
	try {
		const row = await db
			.prepare(
				`SELECT 1 AS pinned
				 FROM decks
				 WHERE id = ? AND user_id = ?
				   AND audio_keep_until IS NOT NULL
				   AND audio_keep_until > datetime('now')
				 LIMIT 1`
			)
			.bind(deckId, userId)
			.first<{ pinned: number }>();
		return row !== null;
	} catch (err) {
		if (isMissingSchemaError(err)) return false;
		throw err;
	}
}

/** SQLite datetime modifier for this object's lifecycle deletion, mirroring the bucket rules. */
function retentionModifier(pinned: boolean): string {
	return `+${pinned ? PIN_RETENTION_DAYS : STD_RETENTION_DAYS} days`;
}

/**
 * Record (or refresh) the per-user cache index for one clip, in lock-step with R2: called on
 * generation and on every refresh re-write, setting `expires_at` to the same point R2 will delete
 * the object. Also opportunistically sweeps this user's already-expired rows so stats stay honest.
 */
export async function recordCachedAudio(
	db: D1Database,
	userId: string,
	hash: string,
	bytes: number,
	pinned: boolean
): Promise<void> {
	try {
		await db.batch([
			db
				.prepare(
					`INSERT INTO tts_audio (user_id, hash, bytes, pinned, expires_at, updated_at)
					 VALUES (?, ?, ?, ?, datetime('now', ?), datetime('now'))
					 ON CONFLICT(user_id, hash) DO UPDATE SET
					   bytes = excluded.bytes,
					   pinned = excluded.pinned,
					   expires_at = excluded.expires_at,
					   updated_at = excluded.updated_at`
				)
				.bind(userId, hash, bytes, pinned ? 1 : 0, retentionModifier(pinned)),
			db
				.prepare(`DELETE FROM tts_audio WHERE user_id = ? AND expires_at <= datetime('now')`)
				.bind(userId)
		]);
	} catch (err) {
		if (isMissingSchemaError(err)) return;
		throw err;
	}
}

/** How long the cache-event monitor retains rows; pruned on read so it never grows unbounded. */
const CACHE_EVENT_RETENTION = '-14 days';

/** Record one /api/tts request's cache outcome for the settings monitor (no card text stored). */
export async function recordCacheEvent(
	db: D1Database,
	userId: string,
	status: string,
	chars: number,
	hash?: string
): Promise<void> {
	if (hash) {
		try {
			await db
				.prepare(`INSERT INTO tts_cache_events (user_id, status, chars, hash) VALUES (?, ?, ?, ?)`)
				.bind(userId, status, chars, hash)
				.run();
			return;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.includes('no column named hash')) {
				// Older production DBs can lag the optional diagnostic hash migration.
			} else if (isMissingSchemaError(err)) {
				return;
			} else {
				throw err;
			}
		}
	}
	try {
		await db
			.prepare(`INSERT INTO tts_cache_events (user_id, status, chars) VALUES (?, ?, ?)`)
			.bind(userId, status, chars)
			.run();
	} catch (err) {
		if (isMissingSchemaError(err)) return;
		throw err;
	}
}

export interface TtsCacheEventStats {
	/** Per-status totals over the retained window. */
	by_status: Array<{ status: string; count: number; chars: number }>;
	hits: number;
	misses: number;
	/** Characters served from cache (edge-hit + r2-hit) — i.e. not re-billed by the provider. */
	saved_chars: number;
	/** Characters freshly synthesized (miss / no-bucket). */
	spent_chars: number;
	/** Most recent events for the debug table. */
	recent: Array<{ status: string; chars: number; created_at: string }>;
}

/** Aggregate the cache-event log for the settings monitor; prunes old rows first. */
export async function getCacheEventStats(
	db: D1Database,
	userId: string,
	includeRecent = false
): Promise<TtsCacheEventStats> {
	const empty = { by_status: [], hits: 0, misses: 0, saved_chars: 0, spent_chars: 0, recent: [] };

	try {
		await db
			.prepare(`DELETE FROM tts_cache_events WHERE user_id = ? AND created_at < datetime('now', ?)`)
			.bind(userId, CACHE_EVENT_RETENTION)
			.run();
	} catch (err) {
		if (isMissingSchemaError(err)) return empty;
		throw err;
	}

	const totalsPromise = db
		.prepare(
			`SELECT status, COUNT(*) AS count, COALESCE(SUM(chars), 0) AS chars
			 FROM tts_cache_events WHERE user_id = ? GROUP BY status`
		)
		.bind(userId)
		.all<{ status: string; count: number; chars: number }>();
	const recentPromise = includeRecent
		? db
			.prepare(
				`SELECT status, chars, created_at FROM tts_cache_events
				 WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 25`
			)
			.bind(userId)
			.all<{ status: string; chars: number; created_at: string }>()
		: Promise.resolve({ results: [] as Array<{ status: string; chars: number; created_at: string }> });

	let totals: { results: Array<{ status: string; count: number; chars: number }> };
	let recent: { results: Array<{ status: string; chars: number; created_at: string }> };
	try {
		[totals, recent] = await Promise.all([
			totalsPromise,
			recentPromise
		]);
	} catch (err) {
		if (isMissingSchemaError(err)) return empty;
		throw err;
	}

	const by_status = totals.results;
	const isHit = (status: string) =>
		status === 'edge-hit' || status === 'r2-hit' || status === 'inflight-hit';
	const isBilled = (status: string) =>
		status === 'miss' || status === 'no-bucket' || status === 'miss-store-failed';
	let hits = 0, misses = 0, saved_chars = 0, spent_chars = 0;
	for (const row of by_status) {
		if (isHit(row.status)) {
			hits += row.count;
			saved_chars += row.chars;
		} else if (isBilled(row.status)) {
			misses += row.count;
			spent_chars += row.chars;
		}
	}
	return { by_status, hits, misses, saved_chars, spent_chars, recent: recent.results };
}

export interface TtsCacheStats {
	clips: number;
	bytes: number;
	pinned_clips: number;
}

/** Summarize a user's live cached audio (rows whose R2 object hasn't aged out yet). */
export async function getTtsCacheStats(db: D1Database, userId: string): Promise<TtsCacheStats> {
	let row: TtsCacheStats | null;
	try {
		row = await db
			.prepare(
				`SELECT COUNT(*) AS clips,
				        COALESCE(SUM(bytes), 0) AS bytes,
				        COALESCE(SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END), 0) AS pinned_clips
				 FROM tts_audio
				 WHERE user_id = ? AND expires_at > datetime('now')`
			)
			.bind(userId)
			.first<TtsCacheStats>();
	} catch (err) {
		if (isMissingSchemaError(err)) return { clips: 0, bytes: 0, pinned_clips: 0 };
		throw err;
	}
	return {
		clips: row?.clips ?? 0,
		bytes: row?.bytes ?? 0,
		pinned_clips: row?.pinned_clips ?? 0
	};
}

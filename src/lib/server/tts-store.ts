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
 */
export async function refreshStoredAudio(
	bucket: R2Bucket,
	hash: string,
	stored: StoredAudio,
	shouldBePinned: boolean
): Promise<void> {
	if (stored.pinned !== shouldBePinned) {
		await putStoredAudio(bucket, hash, stored.bytes, shouldBePinned, stored.contentType);
		await bucket.delete(keyFor(hash, stored.pinned));
		return;
	}
	if (Date.now() - stored.uploadedMs > REFRESH_AFTER_MS) {
		await putStoredAudio(bucket, hash, stored.bytes, shouldBePinned, stored.contentType);
	}
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
}

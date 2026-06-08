import { synthesizeElevenLabsSpeech, type ElevenLabsTtsSettings } from './tts';
import { calculateElevenLabsTtsCost, logUsage } from './usage';
import { estimateMp3DurationMs } from '$lib/listen/sentences';

export const LISTEN_CACHE_KEY_PREFIX = 'listen-cache';
const CACHE_EXTEND_DAYS = 14;
const MAX_SYNTH_RETRIES = 2;

/**
 * Floor below which a 200 response cannot be real speech. ElevenLabs occasionally returns a
 * successful status with an empty or truncated body; at 128 kbps CBR (16 bytes/ms) 512 bytes is
 * ~32 ms — essentially silence. Any genuine sentence (>=30 chars) is multiple KB, so this never
 * rejects real audio but reliably catches the empty-body failure that used to get cached and
 * billed as valid (and then re-served broken forever).
 */
const MIN_AUDIO_BYTES = 512;

/** KV key namespace for the per-sentence synthesis lock that prevents concurrent double-billing. */
const SYNTH_LOCK_PREFIX = 'listen-synth';
/** Lock auto-expires so a crashed generator can never wedge a sentence permanently. */
const SYNTH_LOCK_TTL_SECONDS = 60;
/** While another generator holds the lock, poll the cache this many times before giving up. */
const LOCK_WAIT_ATTEMPTS = 20;
const LOCK_WAIT_INTERVAL_MS = 300;

/**
 * Dedupe concurrent calls *within the same Worker isolate*: two simultaneous stream requests for
 * the same sentence share a single in-flight synthesis promise instead of both calling ElevenLabs.
 * This covers the common double-tap / two-tab case. The KV lock below extends best-effort dedupe
 * across isolates (KV has no atomic compare-and-set, so a sub-second cross-isolate race can still
 * slip through — acceptable: it only costs one extra generation, never corrupts state).
 */
const inFlightSynth = new Map<string, Promise<SynthesizeResult>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function listenCacheR2Key(userId: string, sentenceHash: string): string {
	return `${LISTEN_CACHE_KEY_PREFIX}/${userId}/${sentenceHash}.mp3`;
}

export interface CachedSentenceRow {
	r2_key: string;
	char_count: number;
	byte_size: number;
	duration_ms: number;
}

/** Look up a cached sentence audio for this user. Returns null if missing or expired. */
export async function findCachedSentence(
	db: D1Database,
	userId: string,
	sentenceHash: string
): Promise<CachedSentenceRow | null> {
	return db
		.prepare(
			`SELECT r2_key, char_count, byte_size, duration_ms
			 FROM listen_sentence_cache
			 WHERE user_id = ? AND sentence_hash = ? AND expires_at > datetime('now')`
		)
		.bind(userId, sentenceHash)
		.first<CachedSentenceRow>();
}

/** Extend the cache window of a recently-played sentence so heavy use keeps it warm. */
export async function refreshCacheExpiry(
	db: D1Database,
	userId: string,
	sentenceHash: string
): Promise<void> {
	await db
		.prepare(
			`UPDATE listen_sentence_cache
			 SET expires_at = datetime('now', '+${CACHE_EXTEND_DAYS} days')
			 WHERE user_id = ? AND sentence_hash = ?`
		)
		.bind(userId, sentenceHash)
		.run();
}

/**
 * Synthesize and return validated MP3 bytes. Retries on network/non-OK errors AND on suspiciously
 * small bodies (an empty 200), so a transient empty response is retried rather than cached. Throws
 * if every attempt fails — the caller then never writes R2, never inserts a cache row, never bills.
 */
async function synthesizeValidatedBytes(
	apiKey: string,
	text: string,
	settings: ElevenLabsTtsSettings,
	languageCode: string | undefined
): Promise<Uint8Array> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= MAX_SYNTH_RETRIES; attempt++) {
		try {
			const response = await synthesizeElevenLabsSpeech(apiKey, text, settings, languageCode);
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.byteLength < MIN_AUDIO_BYTES) {
				throw new Error(`ElevenLabs returned ${bytes.byteLength} bytes (expected audio)`);
			}
			return bytes;
		} catch (err) {
			lastErr = err;
			if (attempt < MAX_SYNTH_RETRIES) {
				await sleep(500 * Math.pow(2, attempt));
			}
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error('TTS failed');
}

export interface SynthesizeResult {
	bytes: Uint8Array;
	durationMs: number;
	cached: boolean;
}

/** Return a cached sentence's bytes if both the row and its R2 object still exist; else null. */
async function loadCached(
	db: D1Database,
	media: R2Bucket,
	userId: string,
	sentenceHash: string,
	waitUntil: (p: Promise<unknown>) => void
): Promise<SynthesizeResult | null> {
	const cached = await findCachedSentence(db, userId, sentenceHash);
	if (!cached) return null;
	const obj = await media.get(cached.r2_key);
	if (obj) {
		waitUntil(refreshCacheExpiry(db, userId, sentenceHash));
		const bytes = new Uint8Array(await obj.arrayBuffer());
		return { bytes, durationMs: cached.duration_ms, cached: true };
	}
	// Stale row pointing at a missing R2 object (lifecycle deleted, etc.): purge and regenerate.
	await db
		.prepare('DELETE FROM listen_sentence_cache WHERE user_id = ? AND sentence_hash = ?')
		.bind(userId, sentenceHash)
		.run();
	return null;
}

/**
 * Get audio bytes for a sentence: cache-first, otherwise call ElevenLabs once, store to R2, insert
 * the cache row, and log usage. Two layers guard against paying ElevenLabs twice for the same
 * sentence when playback overlaps (double-tap, two tabs, browser pre-buffer): an in-isolate
 * in-flight map collapses same-isolate concurrency outright, and a KV lock + post-acquire cache
 * re-check serializes the cross-isolate case best-effort. A failed or empty synthesis throws
 * before any R2 write / cache insert / billing, so users are never charged for audio they can't play.
 */
export async function getOrSynthesizeSentence(
	db: D1Database,
	media: R2Bucket,
	kv: KVNamespace,
	userId: string,
	apiKey: string,
	text: string,
	charCount: number,
	sentenceHash: string,
	settings: ElevenLabsTtsSettings,
	languageCode: string | undefined,
	waitUntil: (p: Promise<unknown>) => void
): Promise<SynthesizeResult> {
	const hit = await loadCached(db, media, userId, sentenceHash, waitUntil);
	if (hit) return hit;

	const lockKey = `${userId}:${sentenceHash}`;

	// Same-isolate dedupe: concurrent callers share one synthesis promise (and thus one bill).
	const existing = inFlightSynth.get(lockKey);
	if (existing) return existing;

	const work = synthesizeAndCache(db, media, kv, userId, apiKey, text, charCount, sentenceHash, settings, languageCode, waitUntil, lockKey);
	inFlightSynth.set(lockKey, work);
	try {
		return await work;
	} finally {
		inFlightSynth.delete(lockKey);
	}
}

async function synthesizeAndCache(
	db: D1Database,
	media: R2Bucket,
	kv: KVNamespace,
	userId: string,
	apiKey: string,
	text: string,
	charCount: number,
	sentenceHash: string,
	settings: ElevenLabsTtsSettings,
	languageCode: string | undefined,
	waitUntil: (p: Promise<unknown>) => void,
	lockKey: string
): Promise<SynthesizeResult> {
	const kvLock = `${SYNTH_LOCK_PREFIX}:${lockKey}`;

	// Cross-isolate soft lock: if another isolate is already generating this sentence, wait for it
	// to land in the cache rather than generating (and billing) a second copy.
	if (await kv.get(kvLock)) {
		for (let i = 0; i < LOCK_WAIT_ATTEMPTS; i++) {
			await sleep(LOCK_WAIT_INTERVAL_MS);
			const ready = await loadCached(db, media, userId, sentenceHash, waitUntil);
			if (ready) return ready;
		}
		// Timed out — the other generator likely died; fall through and generate ourselves.
	}

	await kv.put(kvLock, '1', { expirationTtl: SYNTH_LOCK_TTL_SECONDS });
	try {
		// A generator may have finished in the gap between our cache miss and acquiring the lock.
		const justFinished = await loadCached(db, media, userId, sentenceHash, waitUntil);
		if (justFinished) return justFinished;

		const bytes = await synthesizeValidatedBytes(apiKey, text, settings, languageCode);
		const byteSize = bytes.byteLength;
		const durationMs = estimateMp3DurationMs(byteSize);
		const key = listenCacheR2Key(userId, sentenceHash);

		await media.put(key, bytes, { httpMetadata: { contentType: 'audio/mpeg' } });

		await db
			.prepare(
				`INSERT INTO listen_sentence_cache (user_id, sentence_hash, r2_key, char_count, byte_size, duration_ms)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(user_id, sentence_hash) DO UPDATE SET
					r2_key = excluded.r2_key,
					char_count = excluded.char_count,
					byte_size = excluded.byte_size,
					duration_ms = excluded.duration_ms,
					expires_at = datetime('now', '+${CACHE_EXTEND_DAYS} days')`
			)
			.bind(userId, sentenceHash, key, charCount, byteSize, durationMs)
			.run();

		waitUntil(
			logUsage(db, userId, 'elevenlabs', 'tts', charCount, calculateElevenLabsTtsCost(charCount, settings.elevenlabs_tts_model))
		);

		return { bytes, durationMs, cached: false };
	} finally {
		waitUntil(kv.delete(kvLock));
	}
}

/** Drop expired cache rows and best-effort delete their R2 objects. Cheap to run opportunistically. */
export async function cleanupExpiredSentenceCache(
	db: D1Database,
	media: R2Bucket,
	userId: string
): Promise<void> {
	const expired = await db
		.prepare(
			`SELECT sentence_hash, r2_key FROM listen_sentence_cache
			 WHERE user_id = ? AND expires_at <= datetime('now')`
		)
		.bind(userId)
		.all<{ sentence_hash: string; r2_key: string }>();

	if (!expired.results.length) return;

	await Promise.allSettled(expired.results.map((r) => media.delete(r.r2_key)));
	await db
		.prepare("DELETE FROM listen_sentence_cache WHERE user_id = ? AND expires_at <= datetime('now')")
		.bind(userId)
		.run();
}

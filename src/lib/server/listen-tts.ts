import { synthesizeElevenLabsSpeech, type ElevenLabsTtsSettings } from './tts';
import { calculateElevenLabsTtsCost, logUsage } from './usage';
import { estimateMp3DurationMs } from '$lib/listen/sentences';

export const LISTEN_CACHE_KEY_PREFIX = 'listen-cache';
const CACHE_EXTEND_DAYS = 14;
const MAX_SYNTH_RETRIES = 2;

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

async function synthesizeWithRetry(
	apiKey: string,
	text: string,
	settings: ElevenLabsTtsSettings,
	languageCode: string | undefined
): Promise<Response> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= MAX_SYNTH_RETRIES; attempt++) {
		try {
			return await synthesizeElevenLabsSpeech(apiKey, text, settings, languageCode);
		} catch (err) {
			lastErr = err;
			if (attempt < MAX_SYNTH_RETRIES) {
				await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
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

/**
 * Get audio bytes for a sentence: cache-first, otherwise call ElevenLabs, store to R2,
 * insert the cache row, and log usage. Concurrency-safe enough: a `INSERT OR REPLACE`
 * collapses the rare race where two requests miss-and-generate the same hash.
 */
export async function getOrSynthesizeSentence(
	db: D1Database,
	media: R2Bucket,
	userId: string,
	apiKey: string,
	text: string,
	charCount: number,
	sentenceHash: string,
	settings: ElevenLabsTtsSettings,
	languageCode: string | undefined,
	waitUntil: (p: Promise<unknown>) => void
): Promise<SynthesizeResult> {
	const cached = await findCachedSentence(db, userId, sentenceHash);
	if (cached) {
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
	}

	const response = await synthesizeWithRetry(apiKey, text, settings, languageCode);
	const buffer = await response.arrayBuffer();
	const bytes = new Uint8Array(buffer);
	const byteSize = bytes.byteLength;
	const durationMs = estimateMp3DurationMs(byteSize);
	const key = listenCacheR2Key(userId, sentenceHash);

	await media.put(key, buffer, { httpMetadata: { contentType: 'audio/mpeg' } });

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

	waitUntil(logUsage(db, userId, 'elevenlabs', 'tts', charCount, calculateElevenLabsTtsCost(charCount, settings.elevenlabs_tts_model)));

	return { bytes, durationMs, cached: false };
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

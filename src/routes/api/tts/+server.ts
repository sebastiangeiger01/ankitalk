import { error, json, isHttpError, isRedirect } from '@sveltejs/kit';
import { synthesizeElevenLabsSpeech, synthesizeOpenAISpeech, TtsUpstreamError } from '$lib/server/tts';
import { getUserApiKey } from '$lib/server/user-keys';
import { logUsage, calculateElevenLabsTtsCost, calculateTtsCost } from '$lib/server/usage';
import { getDb } from '$lib/server/db';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import { makeTtsCachePayload } from '$lib/server/tts-cache';
import {
	AUDIO_RESPONSE_HEADERS,
	acquireGenerationLock,
	getStoredAudio,
	isDeckAudioPinned,
	isGenerationLocked,
	putStoredAudio,
	recordCachedAudio,
	refreshStoredAudio,
	releaseGenerationLock,
	ttsHash
} from '$lib/server/tts-store';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/rate-limit';
import type { RequestHandler } from './$types';

/** Cap one TTS call at 5000 chars — matches the ElevenLabs single-call cap. */
const MAX_TTS_TEXT_CHARS = 5000;

/** How long to wait for an in-flight generation (lock held) before re-checking R2 ourselves. */
const LOCK_WAIT_MS = 400;

function edgeCacheKey(hash: string): Request {
	return new Request(`https://tts-cache.internal/v1/${hash}`);
}

function audioResponse(bytes: ArrayBuffer): Response {
	return new Response(bytes, { headers: { ...AUDIO_RESPONSE_HEADERS } });
}

function getEdgeCache(): Cache | null {
	return typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null;
}

export const POST: RequestHandler = async (event) => {
	try {
		return await handleTts(event);
	} catch (err) {
		// SvelteKit status throws (401/400/413/429) and redirects must propagate untouched.
		if (isHttpError(err) || isRedirect(err)) throw err;
		// Everything else — KV, D1, edge cache, crypto, or the speech provider — would
		// otherwise collapse into an opaque 500 {"message":"Internal Error"}. Surface the real
		// reason so the review UI can show it. The distinctive "TTS route failure" marker also
		// proves this build is live (vs. the old opaque body) when verifying on staging.
		console.error('TTS route failure:', err);
		if (err instanceof TtsUpstreamError) {
			return json(
				{
					error: `Speech provider failed (returned ${err.status})`,
					providerStatus: err.status,
					detail: err.detail.replace(/\s+/g, ' ').slice(0, 300)
				},
				{ status: 502 }
			);
		}
		const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		return json({ error: 'TTS route failure', detail: detail.replace(/\s+/g, ' ').slice(0, 300) }, { status: 502 });
	}
};

const handleTts: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	const db = getDb(platform!);
	const kv = platform!.env.KV;
	const bucket = platform!.env.MEDIA;

	await enforceRateLimit(kv, userId, 'tts', RATE_LIMITS.tts_per_minute.limit, RATE_LIMITS.tts_per_minute.windowSec);

	const voiceSettings = await getUserVoiceSettings(db, userId);

	const body = (await request.json().catch(() => ({}))) as {
		text?: unknown;
		voice?: unknown;
		speed?: unknown;
		deckId?: unknown;
	};
	const text = body.text;
	const voice = typeof body.voice === 'string' ? body.voice : undefined;
	const speed = typeof body.speed === 'number' ? body.speed : undefined;
	// Optional: which deck this clip belongs to, so we can honour an exam pin on that deck.
	const deckId = typeof body.deckId === 'string' && body.deckId ? body.deckId : undefined;

	if (typeof text !== 'string' || !text.trim()) {
		throw error(400, 'Missing text');
	}
	if (text.length > MAX_TTS_TEXT_CHARS) {
		throw error(413, `Text too long (max ${MAX_TTS_TEXT_CHARS} characters)`);
	}

	const provider = voiceSettings.voice_provider;
	const ttsModel = provider === 'elevenlabs' ? voiceSettings.elevenlabs_tts_model : 'tts-1';
	const ttsVoice = provider === 'elevenlabs' ? voiceSettings.elevenlabs_voice_id : (voice ?? 'nova');
	// For ElevenLabs the per-request `speed`/tuning live in the user's saved settings,
	// so fold them into the cache key — otherwise changing them would serve stale audio.
	const cacheSpeed = provider === 'elevenlabs' ? voiceSettings.elevenlabs_tts_speed : speed;
	const cacheExtra = provider === 'elevenlabs'
		? JSON.stringify([
			voiceSettings.elevenlabs_stability,
			voiceSettings.elevenlabs_similarity,
			voiceSettings.elevenlabs_style,
			voiceSettings.elevenlabs_speaker_boost
		])
		: undefined;
	// Identity of this exact clip — encodes every synthesis parameter (incl. the user) so
	// different voices/speeds/tunings never collide. Same key for the edge cache and R2.
	const hash = await ttsHash(
		makeTtsCachePayload(userId, text, provider, ttsModel, ttsVoice, cacheSpeed ?? 1.0, cacheExtra)
	);

	// An active exam pin routes this clip to the long-retention R2 prefix and keeps it refreshed.
	const deckPinned = deckId ? await isDeckAudioPinned(db, userId, deckId) : false;

	// 1) Cloudflare edge cache — the hot path, before any DB/provider work.
	const cache = getEdgeCache();
	const cacheKey = cache ? edgeCacheKey(hash) : null;
	if (cache && cacheKey) {
		const cached = await cache.match(cacheKey);
		if (cached) return cached;
	}

	// 2) Durable R2 layer — survives edge eviction, so we never re-pay the provider for a clip we
	// already have. Refresh-on-access (background) keeps it alive / honours the deck's pin status.
	if (bucket) {
		const stored = await getStoredAudio(bucket, hash, deckPinned);
		if (stored) {
			const response = audioResponse(stored.bytes);
			// Refresh the R2 object if it's near expiry / changed pin status, and keep the cache
			// index's expiry in lock-step whenever we actually re-wrote.
			const refreshAndIndex = refreshStoredAudio(bucket, hash, stored, deckPinned).then((rewrote) =>
				rewrote ? recordCachedAudio(db, userId, hash, stored.bytes.byteLength, deckPinned) : undefined
			);
			const bg: Promise<unknown>[] = [refreshAndIndex];
			if (cache && cacheKey) bg.push(cache.put(cacheKey, response.clone()));
			platform?.context?.waitUntil(Promise.all(bg).catch(() => undefined));
			return response;
		}

		// Cache miss. If another request is already generating this exact clip, wait briefly and
		// re-check R2 instead of paying the provider a second time.
		if (await isGenerationLocked(kv, hash)) {
			await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
			const retry = await getStoredAudio(bucket, hash, deckPinned);
			if (retry) {
				const response = audioResponse(retry.bytes);
				if (cache && cacheKey) {
					platform?.context?.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
				}
				return response;
			}
		}
		await acquireGenerationLock(kv, hash);
	}

	try {
		let providerResponse: Response;
		let cost: number;
		if (provider === 'elevenlabs') {
			const apiKey = await getUserApiKey(db, userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
			if (!apiKey) return json({ error: 'Add your ElevenLabs API key in Settings to use text-to-speech' }, { status: 400 });
			providerResponse = await synthesizeElevenLabsSpeech(apiKey, text, voiceSettings);
			cost = calculateElevenLabsTtsCost(text.length, voiceSettings.elevenlabs_tts_model);
		} else {
			const apiKey = await getUserApiKey(db, userId, 'openai', platform!.env.ENCRYPTION_KEY);
			if (!apiKey) return json({ error: 'Add your OpenAI API key in Settings to use text-to-speech' }, { status: 400 });
			providerResponse = await synthesizeOpenAISpeech(apiKey, text, voice as Parameters<typeof synthesizeOpenAISpeech>[2], speed);
			cost = calculateTtsCost(text.length);
		}

		// Buffer once so we can persist to R2 + edge AND still return the audio to the caller.
		const bytes = await providerResponse.arrayBuffer();
		const response = audioResponse(bytes);

		const bg: Promise<unknown>[] = [
			logUsage(db, userId, provider === 'elevenlabs' ? 'elevenlabs' : 'openai', 'tts', text.length, cost)
		];
		if (bucket) {
			bg.push(putStoredAudio(bucket, hash, bytes, deckPinned));
			bg.push(recordCachedAudio(db, userId, hash, bytes.byteLength, deckPinned));
		}
		if (cache && cacheKey) bg.push(cache.put(cacheKey, response.clone()));
		platform?.context?.waitUntil(Promise.all(bg).catch(() => undefined));

		return response;
	} finally {
		// Release on every exit (success, missing-key early return, or throw). Delete is idempotent.
		if (bucket) platform?.context?.waitUntil(releaseGenerationLock(kv, hash).catch(() => undefined));
	}
};

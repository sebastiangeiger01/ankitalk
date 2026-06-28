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
	recordCacheEvent,
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
const LOCK_WAIT_ATTEMPTS = 20;
const LOCK_WAIT_INTERVAL_MS = 300;

interface GeneratedAudio {
	bytes: ArrayBuffer;
	storeHeader: string;
	cacheStatus: string;
}

/**
 * Same-isolate in-flight generation collapse. Cloudflare KV has no atomic compare-and-set, so the
 * cross-isolate lock is best-effort; this closes the common same-isolate overlap completely.
 */
const inFlightGenerations = new Map<string, Promise<GeneratedAudio>>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function edgeCacheKey(hash: string): Request {
	return new Request(`https://tts-cache.internal/v1/${hash}`);
}

/**
 * `status` is a diagnostic surfaced as `X-TTS-Cache` so cache behaviour is visible in the browser
 * Network tab without server logs: `r2-hit` (served from R2), `miss` (freshly synthesized + stored),
 * `edge-hit` (served from the Cloudflare edge cache), `no-bucket` (R2 binding missing). `X-TTS-Hash`
 * lets us confirm the same card produces the same cache key across sessions.
 */
function audioResponse(bytes: ArrayBuffer, status: string, hash: string): Response {
	return new Response(bytes, {
		headers: { ...AUDIO_RESPONSE_HEADERS, 'X-TTS-Cache': status, 'X-TTS-Hash': hash.slice(0, 12) }
	});
}

function cacheOnlyMissResponse(hash: string): Response {
	return new Response(null, {
		status: 204,
		headers: { 'X-TTS-Cache': 'cache-only-miss', 'X-TTS-Hash': hash.slice(0, 12) }
	});
}

function canWarmEdge(status: string): boolean {
	return status === 'miss' || status === 'r2-hit' || status === 'inflight-hit';
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

	const voiceSettings = await getUserVoiceSettings(db, userId);

	const body = (await request.json().catch(() => ({}))) as {
		text?: unknown;
		voice?: unknown;
		speed?: unknown;
		deckId?: unknown;
		generate?: unknown;
	};
	const text = body.text;
	const voice = typeof body.voice === 'string' ? body.voice : undefined;
	const speed = typeof body.speed === 'number' ? body.speed : undefined;
	const allowGenerate = body.generate !== false;
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

	// Record this request's cache outcome (status + character count, never the card text) so the
	// settings monitor can show hit rate and how many characters caching saved from the provider.
	const logEvent = (status: string) =>
		platform?.context?.waitUntil(recordCacheEvent(db, userId, status, text.length, hash).catch(() => undefined));

	// 1) Cloudflare edge cache — the hot path, before any DB/provider work.
	const cache = getEdgeCache();
	const cacheKey = cache ? edgeCacheKey(hash) : null;
	if (cache && cacheKey) {
		const cached = await cache.match(cacheKey);
		if (cached) {
			const tagged = new Response(cached.body, cached);
			tagged.headers.set('X-TTS-Cache', 'edge-hit');
			tagged.headers.set('X-TTS-Hash', hash.slice(0, 12));
			logEvent('edge-hit');
			return tagged;
		}
	}

	// 2) Durable R2 layer — survives edge eviction, so we never re-pay the provider for a clip we
	// already have. Refresh-on-access (background) keeps it alive / honours the deck's pin status.
	if (bucket) {
		const stored = await getStoredAudio(bucket, hash, deckPinned);
		if (stored) {
			const response = audioResponse(stored.bytes, 'r2-hit', hash);
			// Refresh the R2 object if it's near expiry / changed pin status, and keep the cache
			// index's expiry in lock-step whenever we actually re-wrote.
			const refreshAndIndex = refreshStoredAudio(bucket, hash, stored, deckPinned).then((rewrote) =>
				rewrote ? recordCachedAudio(db, userId, hash, stored.bytes.byteLength, deckPinned) : undefined
			);
			const bg: Promise<unknown>[] = [refreshAndIndex];
			if (cache && cacheKey) bg.push(cache.put(cacheKey, response.clone()));
			platform?.context?.waitUntil(Promise.all(bg).catch(() => undefined));
			logEvent('r2-hit');
			return response;
		}

		// Cache miss. If another request is already generating this exact clip, wait briefly and
		// re-check R2 instead of paying the provider a second time.
		if (!allowGenerate) {
			logEvent('cache-only-miss');
			return cacheOnlyMissResponse(hash);
		}

		const inFlight = inFlightGenerations.get(hash);
		if (inFlight) {
			const generated = await inFlight;
			const response = audioResponse(generated.bytes, 'inflight-hit', hash);
			if (cache && cacheKey && canWarmEdge(generated.cacheStatus)) {
				platform?.context?.waitUntil(cache.put(cacheKey, audioResponse(generated.bytes, generated.cacheStatus, hash)).catch(() => undefined));
			}
			logEvent('inflight-hit');
			return response;
		}

		if (await isGenerationLocked(kv, hash)) {
			for (let i = 0; i < LOCK_WAIT_ATTEMPTS; i++) {
				await sleep(LOCK_WAIT_INTERVAL_MS);
				const retry = await getStoredAudio(bucket, hash, deckPinned);
				if (retry) {
					const response = audioResponse(retry.bytes, 'r2-hit', hash);
					if (cache && cacheKey) {
						platform?.context?.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
					}
					logEvent('r2-hit');
					return response;
				}
				const pending = inFlightGenerations.get(hash);
				if (pending) {
					const generated = await pending;
					const response = audioResponse(generated.bytes, 'inflight-hit', hash);
					if (cache && cacheKey && canWarmEdge(generated.cacheStatus)) {
						platform?.context?.waitUntil(cache.put(cacheKey, audioResponse(generated.bytes, generated.cacheStatus, hash)).catch(() => undefined));
					}
					logEvent('inflight-hit');
					return response;
				}
			}
		}
		await acquireGenerationLock(kv, hash);

		const justStored = await getStoredAudio(bucket, hash, deckPinned);
		if (justStored) {
			const response = audioResponse(justStored.bytes, 'r2-hit', hash);
			if (cache && cacheKey) {
				platform?.context?.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
			}
			platform?.context?.waitUntil(releaseGenerationLock(kv, hash).catch(() => undefined));
			logEvent('r2-hit');
			return response;
		}
	}

	if (!allowGenerate) {
		logEvent('cache-only-miss');
		return cacheOnlyMissResponse(hash);
	}

	try {
		// Only requests that will actually call the (paid) provider consume the TTS rate-limit
		// budget. Every cache hit above (edge / R2 / in-flight) and every cache-only probe returned
		// without reaching here, so they no longer cost a KV read+write each — that was the bulk of
		// review traffic. The limiter still caps provider spend, which is its only real purpose, and
		// runs inside this try so the generation lock is released by the finally even on a 429.
		await enforceRateLimit(kv, userId, 'tts', RATE_LIMITS.tts_per_minute.limit, RATE_LIMITS.tts_per_minute.windowSec);

		const work = (async (): Promise<GeneratedAudio> => {
			let providerResponse: Response;
			let cost: number;
			if (provider === 'elevenlabs') {
				const apiKey = await getUserApiKey(db, userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
				if (!apiKey) throw error(400, 'Add your ElevenLabs API key in Settings to use text-to-speech');
				providerResponse = await synthesizeElevenLabsSpeech(apiKey, text, voiceSettings);
				cost = calculateElevenLabsTtsCost(text.length, voiceSettings.elevenlabs_tts_model);
			} else {
				const apiKey = await getUserApiKey(db, userId, 'openai', platform!.env.ENCRYPTION_KEY);
				if (!apiKey) throw error(400, 'Add your OpenAI API key in Settings to use text-to-speech');
				providerResponse = await synthesizeOpenAISpeech(apiKey, text, voice as Parameters<typeof synthesizeOpenAISpeech>[2], speed);
				cost = calculateTtsCost(text.length);
			}

			// The provider has now been billed. Buffer the bytes once so we can persist to R2 + edge AND
			// still return the audio to the caller.
			const bytes = await providerResponse.arrayBuffer();

			// Everything from here is post-billing bookkeeping for a clip we have ALREADY paid for:
			// write it to R2, log usage, update the cache index + cache-event monitor, and warm the edge
			// cache. We bundle it into one promise and register it with waitUntil() so that even if the
			// client disconnects right now (the learner advances/rates, or closes the tab) the Workers
			// runtime keeps this alive to completion. Otherwise the paid clip would be neither stored nor
			// logged and would be re-billed on the next play — the exact leak the cache exists to prevent.
			// We also await the same promise on the happy path so the R2 write lands before we return (no
			// replay race) and we can surface the store outcome via `X-TTS-Store`. A store failure is
			// logged and encoded into the cache-event status (`miss` vs `miss-store-failed`) so the
			// settings monitor reveals R2 write failures without DevTools, but never fails the request.
			const persist = (async (): Promise<{ storeHeader: string; cacheStatus: string }> => {
				let eventStatus = bucket ? 'miss' : 'no-bucket';
				let storeHeader = 'ok';
				if (bucket) {
					try {
						await putStoredAudio(bucket, hash, bytes, deckPinned);
					} catch (err) {
						console.error('[tts] R2 put failed:', err);
						const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
						storeHeader = `failed: ${detail.replace(/\s+/g, ' ').slice(0, 120)}`;
						eventStatus = 'miss-store-failed';
					}
				}
				const edgeWrite =
					cache && cacheKey && canWarmEdge(eventStatus)
						? cache.put(cacheKey, audioResponse(bytes, eventStatus, hash))
						: undefined;
				await Promise.all([
					recordCacheEvent(db, userId, eventStatus, text.length, hash).catch(() => undefined),
					logUsage(db, userId, provider === 'elevenlabs' ? 'elevenlabs' : 'openai', 'tts', text.length, cost).catch(() => undefined),
					bucket && eventStatus === 'miss' ? recordCachedAudio(db, userId, hash, bytes.byteLength, deckPinned).catch(() => undefined) : undefined,
					edgeWrite?.catch(() => undefined)
				]);
				return { storeHeader, cacheStatus: eventStatus };
			})();
			platform?.context?.waitUntil(persist.catch(() => undefined));

			const { storeHeader, cacheStatus } = await persist;
			return { bytes, storeHeader, cacheStatus };
		})();
		inFlightGenerations.set(hash, work);
		work.finally(() => {
			if (inFlightGenerations.get(hash) === work) inFlightGenerations.delete(hash);
		}).catch(() => undefined);

		const generated = await work;
		const response = audioResponse(generated.bytes, generated.cacheStatus, hash);
		if (bucket) response.headers.set('X-TTS-Store', generated.storeHeader);
		return response;
	} finally {
		// Release on every exit (success, missing-key early return, or throw). Delete is idempotent.
		if (bucket) platform?.context?.waitUntil(releaseGenerationLock(kv, hash).catch(() => undefined));
	}
};

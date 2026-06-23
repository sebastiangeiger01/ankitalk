import { error, json } from '@sveltejs/kit';
import { synthesizeElevenLabsSpeech, synthesizeOpenAISpeech, TtsUpstreamError } from '$lib/server/tts';
import { getUserApiKey } from '$lib/server/user-keys';
import { logUsage, calculateElevenLabsTtsCost, calculateTtsCost } from '$lib/server/usage';
import { getDb } from '$lib/server/db';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import { makeTtsCachePayload } from '$lib/server/tts-cache';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/rate-limit';
import type { RequestHandler } from './$types';
import type { VoiceProvider } from '$lib/voice';

/** Cap one TTS call at 5000 chars — matches the ElevenLabs single-call cap. */
const MAX_TTS_TEXT_CHARS = 5000;

async function makeTtsCacheRequest(
	userId: string,
	text: string,
	provider: VoiceProvider,
	model: string,
	voice?: string,
	speed?: number,
	extra?: string
): Promise<Request> {
	const payload = makeTtsCachePayload(userId, text, provider, model, voice ?? '', speed ?? 1.0, extra);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
	const hash = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return new Request(`https://tts-cache.internal/v1/${hash}`);
}

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	const db = getDb(platform!);

	await enforceRateLimit(platform!.env.KV, userId, 'tts', RATE_LIMITS.tts_per_minute.limit, RATE_LIMITS.tts_per_minute.windowSec);

	const voiceSettings = await getUserVoiceSettings(db, userId);

	const body = (await request.json().catch(() => ({}))) as { text?: unknown; voice?: unknown; speed?: unknown };
	const text = body.text;
	const voice = typeof body.voice === 'string' ? body.voice : undefined;
	const speed = typeof body.speed === 'number' ? body.speed : undefined;

	if (typeof text !== 'string' || !text.trim()) {
		throw error(400, 'Missing text');
	}
	if (text.length > MAX_TTS_TEXT_CHARS) {
		throw error(413, `Text too long (max ${MAX_TTS_TEXT_CHARS} characters)`);
	}

	// Check Cloudflare edge cache before hitting OpenAI or even fetching the API key.
	// Cache key encodes all synthesis parameters so different voices/speeds get separate entries.
	const cache = typeof caches !== 'undefined'
		? (caches as unknown as { default: Cache }).default
		: null;
	const provider = voiceSettings.voice_provider;
	const ttsModel = provider === 'elevenlabs'
		? voiceSettings.elevenlabs_tts_model
		: 'tts-1';
	const ttsVoice = provider === 'elevenlabs'
		? voiceSettings.elevenlabs_voice_id
		: (voice ?? 'nova');
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
	const cacheKey = cache
		? await makeTtsCacheRequest(userId, text, provider, ttsModel, ttsVoice, cacheSpeed, cacheExtra)
		: null;

	if (cache && cacheKey) {
		const cached = await cache.match(cacheKey);
		if (cached) return cached;
	}

	let response: Response;
	let cost: number;
	try {
		if (provider === 'elevenlabs') {
			const apiKey = await getUserApiKey(db, userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
			if (!apiKey) return json({ error: 'Add your ElevenLabs API key in Settings to use text-to-speech' }, { status: 400 });
			response = await synthesizeElevenLabsSpeech(apiKey, text, voiceSettings);
			cost = calculateElevenLabsTtsCost(text.length, voiceSettings.elevenlabs_tts_model);
		} else {
			const apiKey = await getUserApiKey(db, userId, 'openai', platform!.env.ENCRYPTION_KEY);
			if (!apiKey) return json({ error: 'Add your OpenAI API key in Settings to use text-to-speech' }, { status: 400 });
			response = await synthesizeOpenAISpeech(apiKey, text, voice as Parameters<typeof synthesizeOpenAISpeech>[2], speed);
			cost = calculateTtsCost(text.length);
		}
	} catch (err) {
		// Don't let a provider failure collapse into an opaque 500. Surface the real upstream
		// status and reason so the client can show "TTS HTTP 502: ... (provider 429 ...)".
		if (err instanceof TtsUpstreamError) {
			console.error(`TTS provider failure (${provider}, status ${err.status}): ${err.detail}`);
			return json(
				{
					error: `Speech provider failed (${provider} returned ${err.status})`,
					providerStatus: err.status,
					detail: err.detail.replace(/\s+/g, ' ').slice(0, 300)
				},
				{ status: 502 }
			);
		}
		throw err;
	}

	// Cache the synthesized audio at the edge and log usage in the background.
	const bgWork: Promise<unknown>[] = [logUsage(db, userId, provider === 'elevenlabs' ? 'elevenlabs' : 'openai', 'tts', text.length, cost)];
	if (cache && cacheKey) bgWork.push(cache.put(cacheKey, response.clone()));
	platform?.context?.waitUntil(Promise.all(bgWork));

	return response;
};

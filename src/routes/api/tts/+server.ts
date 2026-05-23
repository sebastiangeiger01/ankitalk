import { error, json } from '@sveltejs/kit';
import { synthesizeElevenLabsSpeech, synthesizeOpenAISpeech } from '$lib/server/tts';
import { getUserApiKey } from '$lib/server/user-keys';
import { logUsage, calculateElevenLabsTtsCost, calculateTtsCost } from '$lib/server/usage';
import { getDb } from '$lib/server/db';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import { makeTtsCachePayload } from '$lib/server/tts-cache';
import type { RequestHandler } from './$types';
import type { VoiceProvider } from '$lib/voice';

async function makeTtsCacheRequest(
	userId: string,
	text: string,
	provider: VoiceProvider,
	model: string,
	voice?: string,
	speed?: number
): Promise<Request> {
	const payload = makeTtsCachePayload(userId, text, provider, model, voice ?? '', speed ?? 1.0);
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
	const voiceSettings = await getUserVoiceSettings(db, userId);

	const body = (await request.json()) as { text: string; voice?: string; speed?: number };
	const { text, voice, speed } = body;

	if (!text || typeof text !== 'string') {
		throw error(400, 'Missing text');
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
	const cacheKey = cache
		? await makeTtsCacheRequest(userId, text, provider, ttsModel, ttsVoice, speed)
		: null;

	if (cache && cacheKey) {
		const cached = await cache.match(cacheKey);
		if (cached) return cached;
	}

	let response: Response;
	let cost: number;
	if (provider === 'elevenlabs') {
		const apiKey = await getUserApiKey(db, userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
		if (!apiKey) return json({ error: 'Add your ElevenLabs API key in Settings to use text-to-speech' }, { status: 400 });
		response = await synthesizeElevenLabsSpeech(apiKey, text, voiceSettings);
		cost = calculateElevenLabsTtsCost(text.length);
	} else {
		const apiKey = await getUserApiKey(db, userId, 'openai', platform!.env.ENCRYPTION_KEY);
		if (!apiKey) return json({ error: 'Add your OpenAI API key in Settings to use text-to-speech' }, { status: 400 });
		response = await synthesizeOpenAISpeech(apiKey, text, voice as Parameters<typeof synthesizeOpenAISpeech>[2], speed);
		cost = calculateTtsCost(text.length);
	}

	// Cache the synthesized audio at the edge and log usage in the background.
	const bgWork: Promise<unknown>[] = [logUsage(db, userId, provider === 'elevenlabs' ? 'elevenlabs' : 'openai', 'tts', text.length, cost)];
	if (cache && cacheKey) bgWork.push(cache.put(cacheKey, response.clone()));
	platform?.context?.waitUntil(Promise.all(bgWork));

	return response;
};

import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserApiKey } from '$lib/server/user-keys';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import { calculateElevenLabsSttCost, logUsage } from '$lib/server/usage';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/rate-limit';
import type { RequestHandler } from './$types';

function normalizeLanguage(value: string | null): string | undefined {
	if (value === 'en' || value === 'de') return value;
	return undefined;
}

export const GET: RequestHandler = async ({ url, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	const db = getDb(platform!);
	await enforceRateLimit(platform!.env.KV, userId, 'stt_token', RATE_LIMITS.stt_token_per_minute.limit, RATE_LIMITS.stt_token_per_minute.windowSec);

	const apiKey = await getUserApiKey(db, userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) return json({ error: 'Add your ElevenLabs API key in Settings to use voice commands' }, { status: 400 });

	const settings = await getUserVoiceSettings(db, userId);
	const tokenResponse = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
		method: 'POST',
		headers: { 'xi-api-key': apiKey }
	});

	const data = (await tokenResponse.json().catch(() => ({}))) as { token?: string; detail?: string };
	if (!tokenResponse.ok || !data.token) {
		// Don't forward ElevenLabs' `data.detail` to the client — it can leak provider-internal
		// info and changes over time. A 401 still means "user's API key is invalid", which is
		// actionable; other statuses get a generic 502.
		throw error(tokenResponse.status === 401 ? 400 : 502, 'Failed to get ElevenLabs realtime token');
	}

	const usagePromise = logUsage(db, userId, 'elevenlabs', 'stt_token', 60, calculateElevenLabsSttCost(60));
	platform?.context?.waitUntil(usagePromise);

	return json({
		token: data.token,
		websocketUrl: 'wss://api.elevenlabs.io/v1/speech-to-text/realtime',
		modelId: settings.elevenlabs_stt_model,
		audioFormat: 'pcm_16000',
		languageCode: normalizeLanguage(url.searchParams.get('language'))
	});
};

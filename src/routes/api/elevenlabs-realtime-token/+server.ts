import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserApiKey } from '$lib/server/user-keys';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import { calculateElevenLabsSttCost, logUsage } from '$lib/server/usage';
import type { RequestHandler } from './$types';

function normalizeLanguage(value: string | null): string | undefined {
	if (value === 'en' || value === 'de') return value;
	return undefined;
}

export const GET: RequestHandler = async ({ url, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	const db = getDb(platform!);
	const apiKey = await getUserApiKey(db, userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) return json({ error: 'Add your ElevenLabs API key in Settings to use voice commands' }, { status: 400 });

	const settings = await getUserVoiceSettings(db, userId);
	const tokenResponse = await fetch('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
		method: 'POST',
		headers: { 'xi-api-key': apiKey }
	});

	const data = (await tokenResponse.json().catch(() => ({}))) as { token?: string; detail?: string };
	if (!tokenResponse.ok || !data.token) {
		const detail = data.detail ? `: ${data.detail}` : '';
		throw error(tokenResponse.status === 401 ? 400 : 502, `Failed to get ElevenLabs realtime token${detail}`);
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

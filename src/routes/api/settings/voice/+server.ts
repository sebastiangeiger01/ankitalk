import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserVoiceSettings, saveUserVoiceSettings } from '$lib/server/voice-settings';
import { DEFAULT_VOICE_SETTINGS, isVoiceProvider, normalizeVoiceSettings } from '$lib/voice';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const settings = await getUserVoiceSettings(db, locals.userId);

	return json({ settings });
};

export const PUT: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const body = (await request.json()) as {
		voice_provider?: unknown;
		elevenlabs_voice_id?: unknown;
		elevenlabs_tts_model?: unknown;
		elevenlabs_stt_model?: unknown;
	};

	if (!isVoiceProvider(body.voice_provider)) {
		throw error(400, 'Invalid voice provider');
	}

	const settings = normalizeVoiceSettings({
		voice_provider: body.voice_provider,
		elevenlabs_voice_id: typeof body.elevenlabs_voice_id === 'string'
			? body.elevenlabs_voice_id
			: DEFAULT_VOICE_SETTINGS.elevenlabs_voice_id,
		elevenlabs_tts_model: typeof body.elevenlabs_tts_model === 'string'
			? body.elevenlabs_tts_model
			: DEFAULT_VOICE_SETTINGS.elevenlabs_tts_model,
		elevenlabs_stt_model: typeof body.elevenlabs_stt_model === 'string'
			? body.elevenlabs_stt_model
			: DEFAULT_VOICE_SETTINGS.elevenlabs_stt_model
	});

	const db = getDb(platform!);
	await saveUserVoiceSettings(db, locals.userId, settings);

	return json({ settings });
};

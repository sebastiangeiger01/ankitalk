import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserVoiceSettings, saveUserVoiceSettings } from '$lib/server/voice-settings';
import {
	DEFAULT_VOICE_SETTINGS,
	defaultVoiceCommandLanguageForLocale,
	isVoiceCommandLanguage,
	isVoiceProvider,
	normalizeVoiceSettings
} from '$lib/voice';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const defaultCommandLanguage = defaultVoiceCommandLanguageForLocale(url.searchParams.get('locale'));
	const settings = await getUserVoiceSettings(db, locals.userId, defaultCommandLanguage);

	return json({ settings });
};

export const PUT: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const body = (await request.json()) as {
		voice_provider?: unknown;
		voice_command_language?: unknown;
		elevenlabs_voice_id?: unknown;
		elevenlabs_tts_model?: unknown;
		elevenlabs_stt_model?: unknown;
		elevenlabs_tts_speed?: unknown;
		elevenlabs_stability?: unknown;
		elevenlabs_similarity?: unknown;
		elevenlabs_style?: unknown;
		elevenlabs_speaker_boost?: unknown;
	};

	if (!isVoiceProvider(body.voice_provider)) {
		throw error(400, 'Invalid voice provider');
	}

	if (
		body.voice_command_language !== undefined &&
		!isVoiceCommandLanguage(body.voice_command_language)
	) {
		throw error(400, 'Invalid voice command language');
	}

	// normalizeVoiceSettings clamps numeric tuning to valid ranges and falls back to
	// defaults for anything unrecognized, so we can pass the raw body through safely.
	const settings = normalizeVoiceSettings({
		voice_provider: body.voice_provider,
		voice_command_language: isVoiceCommandLanguage(body.voice_command_language)
			? body.voice_command_language
			: DEFAULT_VOICE_SETTINGS.voice_command_language,
		elevenlabs_voice_id: typeof body.elevenlabs_voice_id === 'string'
			? body.elevenlabs_voice_id
			: DEFAULT_VOICE_SETTINGS.elevenlabs_voice_id,
		elevenlabs_tts_model: typeof body.elevenlabs_tts_model === 'string'
			? body.elevenlabs_tts_model
			: DEFAULT_VOICE_SETTINGS.elevenlabs_tts_model,
		elevenlabs_stt_model: typeof body.elevenlabs_stt_model === 'string'
			? body.elevenlabs_stt_model
			: DEFAULT_VOICE_SETTINGS.elevenlabs_stt_model,
		elevenlabs_tts_speed: body.elevenlabs_tts_speed as number | undefined,
		elevenlabs_stability: body.elevenlabs_stability as number | undefined,
		elevenlabs_similarity: body.elevenlabs_similarity as number | undefined,
		elevenlabs_style: body.elevenlabs_style as number | undefined,
		elevenlabs_speaker_boost: body.elevenlabs_speaker_boost as boolean | undefined
	});

	const db = getDb(platform!);
	await saveUserVoiceSettings(db, locals.userId, settings);

	return json({ settings });
};

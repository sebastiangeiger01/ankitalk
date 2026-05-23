import {
	DEFAULT_VOICE_SETTINGS,
	normalizeVoiceSettings,
	type UserVoiceSettings,
	type VoiceCommandLanguage,
	type VoiceSettingsInput
} from '$lib/voice';

export async function getUserVoiceSettings(
	db: D1Database,
	userId: string,
	defaultVoiceCommandLanguage?: VoiceCommandLanguage
): Promise<UserVoiceSettings> {
	const row = await db
		.prepare(
			`SELECT voice_provider, voice_command_language, elevenlabs_voice_id, elevenlabs_tts_model, elevenlabs_stt_model,
				elevenlabs_tts_speed, elevenlabs_stability, elevenlabs_similarity, elevenlabs_style, elevenlabs_speaker_boost
			 FROM user_voice_settings
			 WHERE user_id = ?`
		)
		.bind(userId)
		.first<VoiceSettingsInput>();

	return normalizeVoiceSettings(row, defaultVoiceCommandLanguage);
}

export async function saveUserVoiceSettings(
	db: D1Database,
	userId: string,
	settings: UserVoiceSettings
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO user_voice_settings (
				user_id,
				voice_provider,
				voice_command_language,
				elevenlabs_voice_id,
				elevenlabs_tts_model,
				elevenlabs_stt_model,
				elevenlabs_tts_speed,
				elevenlabs_stability,
				elevenlabs_similarity,
				elevenlabs_style,
				elevenlabs_speaker_boost,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
			ON CONFLICT(user_id) DO UPDATE SET
				voice_provider = excluded.voice_provider,
				voice_command_language = excluded.voice_command_language,
				elevenlabs_voice_id = excluded.elevenlabs_voice_id,
				elevenlabs_tts_model = excluded.elevenlabs_tts_model,
				elevenlabs_stt_model = excluded.elevenlabs_stt_model,
				elevenlabs_tts_speed = excluded.elevenlabs_tts_speed,
				elevenlabs_stability = excluded.elevenlabs_stability,
				elevenlabs_similarity = excluded.elevenlabs_similarity,
				elevenlabs_style = excluded.elevenlabs_style,
				elevenlabs_speaker_boost = excluded.elevenlabs_speaker_boost,
				updated_at = datetime('now')`
		)
		.bind(
			userId,
			settings.voice_provider,
			settings.voice_command_language || DEFAULT_VOICE_SETTINGS.voice_command_language,
			settings.elevenlabs_voice_id || DEFAULT_VOICE_SETTINGS.elevenlabs_voice_id,
			settings.elevenlabs_tts_model || DEFAULT_VOICE_SETTINGS.elevenlabs_tts_model,
			settings.elevenlabs_stt_model || DEFAULT_VOICE_SETTINGS.elevenlabs_stt_model,
			settings.elevenlabs_tts_speed,
			settings.elevenlabs_stability,
			settings.elevenlabs_similarity,
			settings.elevenlabs_style,
			settings.elevenlabs_speaker_boost ? 1 : 0
		)
		.run();
}

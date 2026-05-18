import { DEFAULT_VOICE_SETTINGS, normalizeVoiceSettings, type UserVoiceSettings } from '$lib/voice';

export async function getUserVoiceSettings(
	db: D1Database,
	userId: string
): Promise<UserVoiceSettings> {
	const row = await db
		.prepare(
			`SELECT voice_provider, elevenlabs_voice_id, elevenlabs_tts_model, elevenlabs_stt_model
			 FROM user_voice_settings
			 WHERE user_id = ?`
		)
		.bind(userId)
		.first<Partial<UserVoiceSettings>>();

	return normalizeVoiceSettings(row);
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
				elevenlabs_voice_id,
				elevenlabs_tts_model,
				elevenlabs_stt_model,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, datetime('now'))
			ON CONFLICT(user_id) DO UPDATE SET
				voice_provider = excluded.voice_provider,
				elevenlabs_voice_id = excluded.elevenlabs_voice_id,
				elevenlabs_tts_model = excluded.elevenlabs_tts_model,
				elevenlabs_stt_model = excluded.elevenlabs_stt_model,
				updated_at = datetime('now')`
		)
		.bind(
			userId,
			settings.voice_provider,
			settings.elevenlabs_voice_id || DEFAULT_VOICE_SETTINGS.elevenlabs_voice_id,
			settings.elevenlabs_tts_model || DEFAULT_VOICE_SETTINGS.elevenlabs_tts_model,
			settings.elevenlabs_stt_model || DEFAULT_VOICE_SETTINGS.elevenlabs_stt_model
		)
		.run();
}

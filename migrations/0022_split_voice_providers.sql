-- Split the all-or-nothing voice_provider into independent TTS and STT axes so a user
-- can e.g. run Deepgram for voice commands while keeping ElevenLabs card audio.
-- Columns stay nullable: normalizeVoiceSettings derives them from the legacy
-- voice_provider when NULL, so unmigrated rows keep working either way.
ALTER TABLE user_voice_settings ADD COLUMN tts_provider TEXT;
ALTER TABLE user_voice_settings ADD COLUMN stt_provider TEXT;

UPDATE user_voice_settings SET
	tts_provider = CASE voice_provider WHEN 'openai_deepgram' THEN 'openai' ELSE 'elevenlabs' END,
	stt_provider = CASE voice_provider WHEN 'openai_deepgram' THEN 'deepgram' ELSE 'elevenlabs' END;

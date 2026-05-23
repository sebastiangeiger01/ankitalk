ALTER TABLE user_voice_settings ADD COLUMN elevenlabs_tts_speed REAL NOT NULL DEFAULT 1.0;
ALTER TABLE user_voice_settings ADD COLUMN elevenlabs_stability REAL NOT NULL DEFAULT 0.5;
ALTER TABLE user_voice_settings ADD COLUMN elevenlabs_similarity REAL NOT NULL DEFAULT 0.75;
ALTER TABLE user_voice_settings ADD COLUMN elevenlabs_style REAL NOT NULL DEFAULT 0.0;
ALTER TABLE user_voice_settings ADD COLUMN elevenlabs_speaker_boost INTEGER NOT NULL DEFAULT 1;

-- 0014_agent_id.sql
-- Stores the user's ElevenLabs Conversational AI agent_id so we can mint signed URLs
-- against it. One agent per user (created in their own ElevenLabs dashboard); we
-- override the prompt + voice + language per conversation via conversation_config_override,
-- so the agent's own configuration in ElevenLabs doesn't need to be tuned at all.

ALTER TABLE user_voice_settings ADD COLUMN elevenlabs_agent_id TEXT;

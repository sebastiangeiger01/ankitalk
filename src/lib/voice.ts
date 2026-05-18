export type VoiceProvider = 'elevenlabs' | 'openai_deepgram';

export interface UserVoiceSettings {
	voice_provider: VoiceProvider;
	elevenlabs_voice_id: string;
	elevenlabs_tts_model: string;
	elevenlabs_stt_model: string;
}

export const DEFAULT_ELEVENLABS_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
export const DEFAULT_ELEVENLABS_TTS_MODEL = 'eleven_flash_v2_5';
export const DEFAULT_ELEVENLABS_STT_MODEL = 'scribe_v2_realtime';

export const DEFAULT_VOICE_SETTINGS: UserVoiceSettings = {
	voice_provider: 'elevenlabs',
	elevenlabs_voice_id: DEFAULT_ELEVENLABS_VOICE_ID,
	elevenlabs_tts_model: DEFAULT_ELEVENLABS_TTS_MODEL,
	elevenlabs_stt_model: DEFAULT_ELEVENLABS_STT_MODEL
};

export function isVoiceProvider(value: unknown): value is VoiceProvider {
	return value === 'elevenlabs' || value === 'openai_deepgram';
}

export function normalizeVoiceSettings(row: Partial<UserVoiceSettings> | null | undefined): UserVoiceSettings {
	return {
		voice_provider: isVoiceProvider(row?.voice_provider)
			? row.voice_provider
			: DEFAULT_VOICE_SETTINGS.voice_provider,
		elevenlabs_voice_id: row?.elevenlabs_voice_id?.trim() || DEFAULT_ELEVENLABS_VOICE_ID,
		elevenlabs_tts_model: row?.elevenlabs_tts_model?.trim() || DEFAULT_ELEVENLABS_TTS_MODEL,
		elevenlabs_stt_model: row?.elevenlabs_stt_model?.trim() || DEFAULT_ELEVENLABS_STT_MODEL
	};
}

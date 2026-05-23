export type VoiceProvider = 'elevenlabs' | 'openai_deepgram';
export type VoiceCommandLanguage = 'auto' | 'en' | 'de';

export interface UserVoiceSettings {
	voice_provider: VoiceProvider;
	voice_command_language: VoiceCommandLanguage;
	elevenlabs_voice_id: string;
	elevenlabs_tts_model: string;
	elevenlabs_stt_model: string;
}

export const DEFAULT_ELEVENLABS_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
export const DEFAULT_ELEVENLABS_TTS_MODEL = 'eleven_flash_v2_5';
export const DEFAULT_ELEVENLABS_STT_MODEL = 'scribe_v2_realtime';

export const DEFAULT_VOICE_SETTINGS: UserVoiceSettings = {
	voice_provider: 'elevenlabs',
	voice_command_language: 'en',
	elevenlabs_voice_id: DEFAULT_ELEVENLABS_VOICE_ID,
	elevenlabs_tts_model: DEFAULT_ELEVENLABS_TTS_MODEL,
	elevenlabs_stt_model: DEFAULT_ELEVENLABS_STT_MODEL
};

export function isVoiceProvider(value: unknown): value is VoiceProvider {
	return value === 'elevenlabs' || value === 'openai_deepgram';
}

export function isVoiceCommandLanguage(value: unknown): value is VoiceCommandLanguage {
	return value === 'auto' || value === 'en' || value === 'de';
}

export function defaultVoiceCommandLanguageForLocale(locale?: string | null): Exclude<VoiceCommandLanguage, 'auto'> {
	return locale?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export function sttLanguageForVoiceCommandLanguage(language: VoiceCommandLanguage): string | undefined {
	return language === 'auto' ? undefined : language;
}

export function normalizeVoiceSettings(
	row: Partial<UserVoiceSettings> | null | undefined,
	defaultVoiceCommandLanguage: VoiceCommandLanguage = DEFAULT_VOICE_SETTINGS.voice_command_language
): UserVoiceSettings {
	return {
		voice_provider: isVoiceProvider(row?.voice_provider)
			? row.voice_provider
			: DEFAULT_VOICE_SETTINGS.voice_provider,
		voice_command_language: isVoiceCommandLanguage(row?.voice_command_language)
			? row.voice_command_language
			: defaultVoiceCommandLanguage,
		elevenlabs_voice_id: row?.elevenlabs_voice_id?.trim() || DEFAULT_ELEVENLABS_VOICE_ID,
		elevenlabs_tts_model: row?.elevenlabs_tts_model?.trim() || DEFAULT_ELEVENLABS_TTS_MODEL,
		elevenlabs_stt_model: row?.elevenlabs_stt_model?.trim() || DEFAULT_ELEVENLABS_STT_MODEL
	};
}

export interface TtsLanguage {
	code: string;
	name: string;
}

/**
 * Languages selectable for Listen generation. Codes are ISO 639-1 and map to ElevenLabs'
 * `language_code` parameter. Enforcement is applied for models that support it (Flash/Turbo
 * v2.5); other models auto-detect, so the value is harmless there.
 */
export const LISTEN_LANGUAGES: TtsLanguage[] = [
	{ code: 'de', name: 'Deutsch' },
	{ code: 'en', name: 'English' },
	{ code: 'es', name: 'Español' },
	{ code: 'fr', name: 'Français' },
	{ code: 'it', name: 'Italiano' },
	{ code: 'pt', name: 'Português' },
	{ code: 'nl', name: 'Nederlands' },
	{ code: 'pl', name: 'Polski' },
	{ code: 'tr', name: 'Türkçe' },
	{ code: 'ru', name: 'Русский' },
	{ code: 'uk', name: 'Українська' },
	{ code: 'cs', name: 'Čeština' },
	{ code: 'sv', name: 'Svenska' },
	{ code: 'da', name: 'Dansk' },
	{ code: 'fi', name: 'Suomi' },
	{ code: 'el', name: 'Ελληνικά' },
	{ code: 'hu', name: 'Magyar' },
	{ code: 'ro', name: 'Română' },
	{ code: 'ar', name: 'العربية' },
	{ code: 'hi', name: 'हिन्दी' },
	{ code: 'ja', name: '日本語' },
	{ code: 'ko', name: '한국어' },
	{ code: 'zh', name: '中文' }
];

export function isListenLanguage(value: unknown): value is string {
	return typeof value === 'string' && LISTEN_LANGUAGES.some((l) => l.code === value);
}

/** ElevenLabs models that honor an explicit `language_code` (others auto-detect). */
export function modelSupportsLanguageCode(modelId: string): boolean {
	return modelId === 'eleven_flash_v2_5' || modelId === 'eleven_turbo_v2_5';
}

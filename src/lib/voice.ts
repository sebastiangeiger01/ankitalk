/**
 * Legacy all-or-nothing provider choice. Kept only to interpret rows saved before the
 * TTS/STT split: 'elevenlabs' meant ElevenLabs for both, 'openai_deepgram' meant OpenAI
 * TTS + Deepgram STT. New code reads {@link TtsProvider}/{@link SttProvider} instead.
 */
export type VoiceProvider = 'elevenlabs' | 'openai_deepgram';
/** Who reads cards aloud. */
export type TtsProvider = 'elevenlabs' | 'openai';
/** Who listens for voice commands during review. Independent of TTS so a user can
 *  keep ElevenLabs voices while running the always-on mic through Deepgram. */
export type SttProvider = 'elevenlabs' | 'deepgram';
export type VoiceCommandLanguage = 'auto' | 'en' | 'de';

export interface UserVoiceSettings {
	tts_provider: TtsProvider;
	stt_provider: SttProvider;
	voice_command_language: VoiceCommandLanguage;
	elevenlabs_voice_id: string;
	elevenlabs_tts_model: string;
	elevenlabs_stt_model: string;
	elevenlabs_tts_speed: number;
	elevenlabs_stability: number;
	elevenlabs_similarity: number;
	elevenlabs_style: number;
	elevenlabs_speaker_boost: boolean;
	/**
	 * Optional ElevenLabs Conversational AI agent_id (format `agent_…`). Empty/null means
	 * the user hasn't set up an agent yet — features that need it should degrade gracefully.
	 * Voice + system prompt + language get overridden per-conversation, so the agent's own
	 * configuration in the ElevenLabs dashboard doesn't matter beyond existing.
	 */
	elevenlabs_agent_id: string | null;
}

export const DEFAULT_ELEVENLABS_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
export const DEFAULT_ELEVENLABS_TTS_MODEL = 'eleven_flash_v2_5';
export const DEFAULT_ELEVENLABS_STT_MODEL = 'scribe_v2_realtime';

export const DEFAULT_VOICE_SETTINGS: UserVoiceSettings = {
	tts_provider: 'elevenlabs',
	stt_provider: 'elevenlabs',
	voice_command_language: 'en',
	elevenlabs_voice_id: DEFAULT_ELEVENLABS_VOICE_ID,
	elevenlabs_tts_model: DEFAULT_ELEVENLABS_TTS_MODEL,
	elevenlabs_stt_model: DEFAULT_ELEVENLABS_STT_MODEL,
	elevenlabs_tts_speed: 1.0,
	elevenlabs_stability: 0.5,
	elevenlabs_similarity: 0.75,
	elevenlabs_style: 0.0,
	elevenlabs_speaker_boost: true,
	elevenlabs_agent_id: null
};

/**
 * Catalog of selectable ElevenLabs TTS models ("versions"). `creditMultiplier`
 * is credits charged per character relative to the standard models: Flash and
 * Turbo bill at half the rate, which drives the cost estimate and the UI hints.
 */
export interface ElevenLabsTtsModelInfo {
	id: string;
	creditMultiplier: number;
}

export const ELEVENLABS_TTS_MODELS: ElevenLabsTtsModelInfo[] = [
	{ id: 'eleven_flash_v2_5', creditMultiplier: 0.5 },
	{ id: 'eleven_turbo_v2_5', creditMultiplier: 0.5 },
	{ id: 'eleven_multilingual_v2', creditMultiplier: 1 },
	{ id: 'eleven_v3', creditMultiplier: 1 }
];

export function elevenLabsModelCreditMultiplier(modelId: string): number {
	return ELEVENLABS_TTS_MODELS.find((m) => m.id === modelId)?.creditMultiplier ?? 1;
}

export function isElevenLabsTtsModel(value: unknown): value is string {
	return typeof value === 'string' && ELEVENLABS_TTS_MODELS.some((m) => m.id === value);
}

export function isVoiceProvider(value: unknown): value is VoiceProvider {
	return value === 'elevenlabs' || value === 'openai_deepgram';
}

export function isTtsProvider(value: unknown): value is TtsProvider {
	return value === 'elevenlabs' || value === 'openai';
}

export function isSttProvider(value: unknown): value is SttProvider {
	return value === 'elevenlabs' || value === 'deepgram';
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

/** Clamp a value into [min, max], falling back to `fallback` for non-finite input. */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const num = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(num)) return fallback;
	return Math.min(max, Math.max(min, num));
}

function toBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === 'boolean') return value;
	if (value === 1 || value === '1') return true;
	if (value === 0 || value === '0') return false;
	return fallback;
}

/**
 * Loose shape accepted by {@link normalizeVoiceSettings}: a raw D1 row (where the
 * speaker-boost flag is an integer and numbers may arrive as strings) or a partial
 * settings object from a request body.
 */
export interface VoiceSettingsInput {
	tts_provider?: unknown;
	stt_provider?: unknown;
	/** Legacy combined provider, still present on rows saved before the TTS/STT split. */
	voice_provider?: unknown;
	voice_command_language?: unknown;
	elevenlabs_voice_id?: string | null;
	elevenlabs_tts_model?: string | null;
	elevenlabs_stt_model?: string | null;
	elevenlabs_tts_speed?: number | string | null;
	elevenlabs_stability?: number | string | null;
	elevenlabs_similarity?: number | string | null;
	elevenlabs_style?: number | string | null;
	elevenlabs_speaker_boost?: boolean | number | null;
	elevenlabs_agent_id?: string | null;
}

/**
 * Loose validator for agent ids. ElevenLabs uses an `agent_…` prefix on conversational AI
 * agents; we trim and length-cap so a stray paste of a longer string can't get through.
 */
export function normalizeAgentId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	if (trimmed.length > 128) return null;
	return trimmed;
}

export function normalizeVoiceSettings(
	row: VoiceSettingsInput | null | undefined,
	defaultVoiceCommandLanguage: VoiceCommandLanguage = DEFAULT_VOICE_SETTINGS.voice_command_language
): UserVoiceSettings {
	const model = row?.elevenlabs_tts_model?.trim();
	// Rows saved before the TTS/STT split only carry `voice_provider`; derive the two
	// axes from it so legacy "OpenAI + Deepgram" users keep their setup untouched.
	const legacy = isVoiceProvider(row?.voice_provider) ? row.voice_provider : 'elevenlabs';
	return {
		tts_provider: isTtsProvider(row?.tts_provider)
			? row.tts_provider
			: legacy === 'openai_deepgram' ? 'openai' : 'elevenlabs',
		stt_provider: isSttProvider(row?.stt_provider)
			? row.stt_provider
			: legacy === 'openai_deepgram' ? 'deepgram' : 'elevenlabs',
		voice_command_language: isVoiceCommandLanguage(row?.voice_command_language)
			? row.voice_command_language
			: defaultVoiceCommandLanguage,
		elevenlabs_voice_id: row?.elevenlabs_voice_id?.trim() || DEFAULT_ELEVENLABS_VOICE_ID,
		elevenlabs_tts_model: isElevenLabsTtsModel(model) ? model : DEFAULT_ELEVENLABS_TTS_MODEL,
		elevenlabs_stt_model: row?.elevenlabs_stt_model?.trim() || DEFAULT_ELEVENLABS_STT_MODEL,
		elevenlabs_tts_speed: clampNumber(row?.elevenlabs_tts_speed, 0.7, 1.2, DEFAULT_VOICE_SETTINGS.elevenlabs_tts_speed),
		elevenlabs_stability: clampNumber(row?.elevenlabs_stability, 0, 1, DEFAULT_VOICE_SETTINGS.elevenlabs_stability),
		elevenlabs_similarity: clampNumber(row?.elevenlabs_similarity, 0, 1, DEFAULT_VOICE_SETTINGS.elevenlabs_similarity),
		elevenlabs_style: clampNumber(row?.elevenlabs_style, 0, 1, DEFAULT_VOICE_SETTINGS.elevenlabs_style),
		elevenlabs_speaker_boost: toBoolean(row?.elevenlabs_speaker_boost, DEFAULT_VOICE_SETTINGS.elevenlabs_speaker_boost),
		elevenlabs_agent_id: normalizeAgentId(row?.elevenlabs_agent_id)
	};
}

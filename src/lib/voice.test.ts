import { describe, expect, it } from 'vitest';
import {
	DEFAULT_VOICE_SETTINGS,
	defaultVoiceCommandLanguageForLocale,
	normalizeVoiceSettings,
	sttLanguageForVoiceCommandLanguage
} from './voice';

describe('voice settings', () => {
	it('defaults to ElevenLabs voice review', () => {
		expect(normalizeVoiceSettings(null)).toEqual(DEFAULT_VOICE_SETTINGS);
	});

	it('preserves explicit legacy provider while filling missing ElevenLabs defaults', () => {
		const settings = normalizeVoiceSettings({ voice_provider: 'openai_deepgram' });
		expect(settings.voice_provider).toBe('openai_deepgram');
		expect(settings.voice_command_language).toBe(DEFAULT_VOICE_SETTINGS.voice_command_language);
		expect(settings.elevenlabs_voice_id).toBe(DEFAULT_VOICE_SETTINGS.elevenlabs_voice_id);
		expect(settings.elevenlabs_tts_model).toBe(DEFAULT_VOICE_SETTINGS.elevenlabs_tts_model);
		expect(settings.elevenlabs_stt_model).toBe(DEFAULT_VOICE_SETTINGS.elevenlabs_stt_model);
	});

	it('defaults command language from the UI locale when no explicit setting exists', () => {
		expect(defaultVoiceCommandLanguageForLocale('de')).toBe('de');
		expect(defaultVoiceCommandLanguageForLocale('de-DE')).toBe('de');
		expect(defaultVoiceCommandLanguageForLocale('en-US')).toBe('en');
		expect(normalizeVoiceSettings({}, 'de').voice_command_language).toBe('de');
	});

	it('maps auto command language to provider auto-detection', () => {
		expect(sttLanguageForVoiceCommandLanguage('auto')).toBeUndefined();
		expect(sttLanguageForVoiceCommandLanguage('en')).toBe('en');
		expect(sttLanguageForVoiceCommandLanguage('de')).toBe('de');
	});
});

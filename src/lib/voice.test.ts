import { describe, expect, it } from 'vitest';
import {
	DEFAULT_VOICE_SETTINGS,
	defaultVoiceCommandLanguageForLocale,
	elevenLabsModelCreditMultiplier,
	isElevenLabsTtsModel,
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

	it('clamps out-of-range tuning values into valid ranges', () => {
		const settings = normalizeVoiceSettings({
			elevenlabs_tts_speed: 5,
			elevenlabs_stability: -1,
			elevenlabs_similarity: 2,
			elevenlabs_style: 0.4
		});
		expect(settings.elevenlabs_tts_speed).toBe(1.2);
		expect(settings.elevenlabs_stability).toBe(0);
		expect(settings.elevenlabs_similarity).toBe(1);
		expect(settings.elevenlabs_style).toBeCloseTo(0.4);
	});

	it('coerces the speaker boost integer column into a boolean', () => {
		expect(normalizeVoiceSettings({ elevenlabs_speaker_boost: 0 as unknown as boolean }).elevenlabs_speaker_boost).toBe(false);
		expect(normalizeVoiceSettings({ elevenlabs_speaker_boost: 1 as unknown as boolean }).elevenlabs_speaker_boost).toBe(true);
	});

	it('falls back to the default model for unknown TTS models', () => {
		expect(normalizeVoiceSettings({ elevenlabs_tts_model: 'made_up_model' }).elevenlabs_tts_model)
			.toBe(DEFAULT_VOICE_SETTINGS.elevenlabs_tts_model);
		expect(isElevenLabsTtsModel('eleven_flash_v2_5')).toBe(true);
		expect(isElevenLabsTtsModel('nope')).toBe(false);
	});

	it('bills Flash/Turbo at half the credit rate of standard models', () => {
		expect(elevenLabsModelCreditMultiplier('eleven_flash_v2_5')).toBe(0.5);
		expect(elevenLabsModelCreditMultiplier('eleven_turbo_v2_5')).toBe(0.5);
		expect(elevenLabsModelCreditMultiplier('eleven_multilingual_v2')).toBe(1);
		expect(elevenLabsModelCreditMultiplier('eleven_v3')).toBe(1);
		expect(elevenLabsModelCreditMultiplier('unknown')).toBe(1);
	});
});

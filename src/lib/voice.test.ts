import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_SETTINGS, normalizeVoiceSettings } from './voice';

describe('voice settings', () => {
	it('defaults to ElevenLabs voice review', () => {
		expect(normalizeVoiceSettings(null)).toEqual(DEFAULT_VOICE_SETTINGS);
	});

	it('preserves explicit legacy provider while filling missing ElevenLabs defaults', () => {
		const settings = normalizeVoiceSettings({ voice_provider: 'openai_deepgram' });
		expect(settings.voice_provider).toBe('openai_deepgram');
		expect(settings.elevenlabs_voice_id).toBe(DEFAULT_VOICE_SETTINGS.elevenlabs_voice_id);
		expect(settings.elevenlabs_tts_model).toBe(DEFAULT_VOICE_SETTINGS.elevenlabs_tts_model);
		expect(settings.elevenlabs_stt_model).toBe(DEFAULT_VOICE_SETTINGS.elevenlabs_stt_model);
	});
});

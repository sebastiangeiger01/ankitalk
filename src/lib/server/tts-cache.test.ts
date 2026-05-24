import { describe, expect, it } from 'vitest';
import { makeTtsCachePayload } from './tts-cache';

describe('TTS cache payload', () => {
	it('separates providers, models, and voices', () => {
		const openai = makeTtsCachePayload('u1', 'hello', 'openai_deepgram', 'tts-1', 'nova', 1);
		const elevenlabs = makeTtsCachePayload('u1', 'hello', 'elevenlabs', 'eleven_flash_v2_5', 'JBFqnCBsd6RMkjVDRZzb', 1);

		expect(openai).not.toBe(elevenlabs);
		expect(elevenlabs).toContain('eleven_flash_v2_5');
	});

	it('busts the cache when ElevenLabs tuning changes', () => {
		const base = makeTtsCachePayload('u1', 'hello', 'elevenlabs', 'eleven_flash_v2_5', 'v1', 1, '[0.5,0.75,0,true]');
		const tuned = makeTtsCachePayload('u1', 'hello', 'elevenlabs', 'eleven_flash_v2_5', 'v1', 1, '[0.8,0.75,0,true]');
		expect(base).not.toBe(tuned);
	});

	it('stays backward compatible without the extra signature', () => {
		const withoutExtra = makeTtsCachePayload('u1', 'hello', 'elevenlabs', 'eleven_flash_v2_5', 'v1', 1);
		expect(withoutExtra).toBe(JSON.stringify(['u1', 'elevenlabs', 'eleven_flash_v2_5', 'hello', 'v1', 1]));
	});
});

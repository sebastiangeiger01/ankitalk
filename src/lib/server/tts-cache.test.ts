import { describe, expect, it } from 'vitest';
import { makeTtsCachePayload } from './tts-cache';

describe('TTS cache payload', () => {
	it('separates providers, models, and voices', () => {
		const openai = makeTtsCachePayload('u1', 'hello', 'openai_deepgram', 'tts-1', 'nova', 1);
		const elevenlabs = makeTtsCachePayload('u1', 'hello', 'elevenlabs', 'eleven_flash_v2_5', 'JBFqnCBsd6RMkjVDRZzb', 1);

		expect(openai).not.toBe(elevenlabs);
		expect(elevenlabs).toContain('eleven_flash_v2_5');
	});
});

import { describe, expect, it } from 'vitest';
import {
	downsampleFloat32ToPCM16,
	parseElevenLabsTranscriptEvent,
	pcm16ToBase64
} from './elevenlabs';

describe('ElevenLabs client helpers', () => {
	it('downsamples float audio into clipped PCM16 samples', () => {
		const input = new Float32Array([0, 0.5, 1.2, -1.2]);
		const pcm = downsampleFloat32ToPCM16(input, 16000, 16000);

		expect([...pcm]).toEqual([0, 16383, 32767, -32768]);
	});

	it('encodes PCM16 audio as base64 bytes', () => {
		const pcm = new Int16Array([0, 32767, -32768]);
		expect(pcm16ToBase64(pcm)).toBe('AAD/fwCA');
	});

	it('maps partial and committed transcript events', () => {
		expect(parseElevenLabsTranscriptEvent({
			message_type: 'partial_transcript',
			text: 'answer'
		})).toEqual({ text: 'answer', isFinal: false });

		expect(parseElevenLabsTranscriptEvent({
			message_type: 'committed_transcript',
			text: 'good'
		})).toEqual({ text: 'good', isFinal: true });

		expect(parseElevenLabsTranscriptEvent({
			message_type: 'session_started',
			text: 'ignored'
		})).toBeNull();
	});
});

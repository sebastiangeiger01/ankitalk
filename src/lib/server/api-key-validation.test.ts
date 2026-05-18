import { describe, expect, it } from 'vitest';
import { validateElevenLabsKey } from './api-key-validation';

describe('ElevenLabs key validation', () => {
	it('validates only the required STT token and TTS endpoints', async () => {
		const calls: string[] = [];
		const fetchMock = async (input: RequestInfo | URL) => {
			calls.push(String(input));
			return new Response('{}', { status: 200 });
		};

		await expect(validateElevenLabsKey('xi-test-key', fetchMock as typeof fetch)).resolves.toEqual({ ok: true });

		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain('/single-use-token/realtime_scribe');
		expect(calls[1]).toContain('/text-to-speech/');
		expect(calls.some((url) => url.includes('/v1/models'))).toBe(false);
	});

	it('returns the provider status when a required ElevenLabs capability is denied', async () => {
		const fetchMock = async () => new Response('{}', { status: 403 });

		await expect(validateElevenLabsKey('xi-test-key', fetchMock as typeof fetch)).resolves.toEqual({
			ok: false,
			status: 403
		});
	});
});

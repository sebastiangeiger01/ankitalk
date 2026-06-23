import { describe, expect, it } from 'vitest';
import { validateElevenLabsKey } from './api-key-validation';

describe('ElevenLabs key validation', () => {
	it('validates every ElevenLabs capability used outside the tutor setup', async () => {
		const calls: string[] = [];
		const fetchMock = async (input: RequestInfo | URL) => {
			calls.push(String(input));
			return new Response('{}', { status: 200 });
		};

		await expect(validateElevenLabsKey('xi-test-key', fetchMock as typeof fetch)).resolves.toEqual({ ok: true });

		expect(calls).toHaveLength(4);
		expect(calls[0]).toContain('/single-use-token/realtime_scribe');
		expect(calls[1]).toContain('/v1/voices');
		expect(calls[2]).toContain('/v1/user/subscription');
		expect(calls[3]).toContain('/text-to-speech/');
		expect(calls.some((url) => url.includes('/v1/models'))).toBe(false);
	});

	it('returns the provider status when a required ElevenLabs capability is denied', async () => {
		const fetchMock = async () => new Response('{}', { status: 403 });

		await expect(validateElevenLabsKey('xi-test-key', fetchMock as typeof fetch)).resolves.toEqual({
			ok: false,
			status: 403,
			capability: 'speech_to_text'
		});
	});

	it('identifies the specific permission that is missing', async () => {
		let call = 0;
		const fetchMock = async () => {
			call += 1;
			return new Response('{}', { status: call === 3 ? 403 : 200 });
		};

		await expect(validateElevenLabsKey('xi-test-key', fetchMock as typeof fetch)).resolves.toEqual({
			ok: false,
			status: 403,
			capability: 'user_read'
		});
	});
});

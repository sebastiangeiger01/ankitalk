import { describe, expect, it } from 'vitest';
import { getUserApiKeyStatus } from './user-keys';

describe('user API key status', () => {
	it('includes ElevenLabs in the status shape', async () => {
		const db = {
			prepare: () => ({
				bind: () => ({
					all: async () => ({
						results: [{ service: 'elevenlabs' }, { service: 'anthropic' }]
					})
				})
			})
		} as unknown as D1Database;

		await expect(getUserApiKeyStatus(db, 'user-1')).resolves.toEqual({
			openai: false,
			deepgram: false,
			anthropic: true,
			elevenlabs: true
		});
	});
});

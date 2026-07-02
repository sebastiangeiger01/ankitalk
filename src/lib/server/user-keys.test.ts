import { describe, expect, it } from 'vitest';
import { encryptApiKey } from './crypto';
import { getUserApiKeyOverview, getUserApiKeyStatus } from './user-keys';

function fakeDb(results: Array<{ service: string; encrypted_key?: string }>): D1Database {
	return {
		prepare: () => ({
			bind: () => ({
				all: async () => ({ results })
			})
		})
	} as unknown as D1Database;
}

describe('user API key status', () => {
	it('includes ElevenLabs in the status shape', async () => {
		const db = fakeDb([{ service: 'elevenlabs' }, { service: 'anthropic' }]);

		await expect(getUserApiKeyStatus(db, 'user-1')).resolves.toEqual({
			openai: false,
			deepgram: false,
			anthropic: true,
			elevenlabs: true
		});
	});
});

describe('user API key overview', () => {
	const masterKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

	it('returns a masked last-4 suffix per configured key', async () => {
		const db = fakeDb([
			{ service: 'openai', encrypted_key: await encryptApiKey('sk-test-key-wxyz', masterKey) },
			{ service: 'elevenlabs', encrypted_key: await encryptApiKey('el-key-1234-abcd', masterKey) }
		]);

		const overview = await getUserApiKeyOverview(db, 'user-1', masterKey);

		expect(overview.status.openai).toBe(true);
		expect(overview.status.elevenlabs).toBe(true);
		expect(overview.suffixes).toEqual({ openai: '…wxyz', elevenlabs: '…abcd' });
	});

	it('omits suffixes when no encryption key is available', async () => {
		const db = fakeDb([
			{ service: 'openai', encrypted_key: await encryptApiKey('sk-test-key-wxyz', masterKey) }
		]);

		const overview = await getUserApiKeyOverview(db, 'user-1');

		expect(overview.status.openai).toBe(true);
		expect(overview.suffixes).toEqual({});
	});

	it('still reports configured when a stored key cannot be decrypted', async () => {
		const db = fakeDb([{ service: 'deepgram', encrypted_key: 'bm90LXJlYWwtY2lwaGVydGV4dA==' }]);

		const overview = await getUserApiKeyOverview(db, 'user-1', masterKey);

		expect(overview.status.deepgram).toBe(true);
		expect(overview.suffixes).toEqual({});
	});
});

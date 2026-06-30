// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { consumeUploadToken, mintUploadToken, UPLOAD_TOKEN_MAX_USES } from './media-upload-token';

function fakeKv() {
	const store = new Map<string, string>();
	const kv = {
		get: (k: string) => Promise.resolve(store.get(k) ?? null),
		put: (k: string, v: string) => {
			store.set(k, v);
			return Promise.resolve();
		},
		delete: (k: string) => {
			store.delete(k);
			return Promise.resolve();
		}
	} as unknown as KVNamespace;
	return { kv, store };
}

describe('upload token mint/consume', () => {
	it('mints a token that then consumes successfully and counts uses', async () => {
		const { kv, store } = fakeKv();
		await mintUploadToken(kv, 'user-1', 'tok');

		const first = await consumeUploadToken(kv, 'tok');
		expect(first).toEqual({ ok: true, userId: 'user-1' });

		const meta = JSON.parse([...store.values()][0]) as { uses: number };
		expect(meta.uses).toBe(1);
	});

	it('rejects an unknown token', async () => {
		const { kv } = fakeKv();
		expect(await consumeUploadToken(kv, 'nope')).toEqual({ ok: false, error: 'Upload link is invalid or has expired.' });
	});

	it('rejects an expired token', async () => {
		const { kv, store } = fakeKv();
		store.set('media-upload:tok', JSON.stringify({ userId: 'user-1', expiresAt: Date.now() - 1000, uses: 0, maxUses: 50 }));
		expect(await consumeUploadToken(kv, 'tok')).toEqual({ ok: false, error: 'Upload link has expired.' });
	});

	it('rejects once the use limit is reached', async () => {
		const { kv, store } = fakeKv();
		store.set(
			'media-upload:tok',
			JSON.stringify({ userId: 'user-1', expiresAt: Date.now() + 60_000, uses: UPLOAD_TOKEN_MAX_USES, maxUses: UPLOAD_TOKEN_MAX_USES })
		);
		const result = await consumeUploadToken(kv, 'tok');
		expect(result.ok).toBe(false);
	});
});

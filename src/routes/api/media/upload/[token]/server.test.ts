// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PUT } from './+server';
import { mintUploadToken } from '$lib/server/media-upload-token';

function fakeKv() {
	const store = new Map<string, string>();
	return {
		get: (k: string) => Promise.resolve(store.get(k) ?? null),
		put: (k: string, v: string) => {
			store.set(k, v);
			return Promise.resolve();
		}
	} as unknown as KVNamespace;
}

function fakeMedia() {
	const store = new Map<string, Uint8Array>();
	const media = {
		put: (k: string, v: ArrayBuffer | Uint8Array) => {
			store.set(k, v instanceof Uint8Array ? v : new Uint8Array(v));
			return Promise.resolve();
		}
	} as unknown as R2Bucket;
	return { media, store };
}

// A 1x1 transparent PNG.
const PNG = Uint8Array.from(
	atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
	(c) => c.charCodeAt(0)
);

type CallOpts = { token: string; filename?: string; body?: Uint8Array; kv: KVNamespace; media: R2Bucket };

async function callPut(opts: CallOpts): Promise<number> {
	const search = opts.filename ? `?filename=${encodeURIComponent(opts.filename)}` : '';
	const url = new URL(`https://ankitalk.com/api/media/upload/${opts.token}${search}`);
	const event = {
		params: { token: opts.token },
		url,
		request: new Request(url, { method: 'PUT', body: (opts.body ?? PNG) as unknown as BodyInit }),
		platform: { env: { KV: opts.kv, MEDIA: opts.media } }
	};
	try {
		const res = await PUT(event as unknown as Parameters<typeof PUT>[0]);
		return res.status;
	} catch (e) {
		return (e as { status?: number }).status ?? -1;
	}
}

describe('PUT /api/media/upload/[token] (the lock behind the hook bypass)', () => {
	it('rejects an unknown token with 401 even though the hook lets the request through', async () => {
		const { media } = fakeMedia();
		expect(await callPut({ token: 'not-a-real-token', filename: 'x.png', kv: fakeKv(), media })).toBe(401);
	});

	it('rejects a missing filename with 400', async () => {
		const kv = fakeKv();
		await mintUploadToken(kv, 'user-1', 'tok');
		const { media } = fakeMedia();
		expect(await callPut({ token: 'tok', kv, media })).toBe(400);
	});

	it('rejects a non-image filename with 415', async () => {
		const kv = fakeKv();
		await mintUploadToken(kv, 'user-1', 'tok');
		const { media } = fakeMedia();
		expect(await callPut({ token: 'tok', filename: 'payload.html', kv, media })).toBe(415);
	});

	it('stores the image under the minting user and returns 201 for a valid token', async () => {
		const kv = fakeKv();
		await mintUploadToken(kv, 'user-1', 'tok');
		const { media, store } = fakeMedia();
		expect(await callPut({ token: 'tok', filename: 'slide.png', kv, media })).toBe(201);
		// Stored under the token owner's namespace, not anything the caller controls.
		const keys = [...store.keys()];
		expect(keys).toHaveLength(1);
		expect(keys[0].startsWith('user-1/')).toBe(true);
	});

	it('rejects an empty body with 400', async () => {
		const kv = fakeKv();
		await mintUploadToken(kv, 'user-1', 'tok');
		const { media } = fakeMedia();
		expect(await callPut({ token: 'tok', filename: 'slide.png', body: new Uint8Array(0), kv, media })).toBe(400);
	});
});

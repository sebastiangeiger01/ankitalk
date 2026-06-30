// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock auth + db so we control whether a request looks authenticated, with no network/DB.
const verifyHankoToken = vi.fn();
vi.mock('$lib/server/auth', () => ({
	getRemoteHankoJwks: () => ({}),
	verifyHankoToken: (...args: unknown[]) => verifyHankoToken(...args)
}));

const first = vi.fn();
vi.mock('$lib/server/db', () => ({
	getDb: () => ({ prepare: () => ({ bind: () => ({ first, run: () => Promise.resolve() }) }) }),
	newId: () => 'new-id'
}));

import { handle } from './hooks.server';

type HandleArg = Parameters<typeof handle>[0];

const RESOLVED = new Response('ok', { status: 200 });

function makeEvent(opts: {
	method: string;
	path: string;
	cookie?: string;
	origin?: string;
	secFetchSite?: string;
}): HandleArg['event'] {
	const headers = new Headers();
	if (opts.origin) headers.set('origin', opts.origin);
	if (opts.secFetchSite) headers.set('sec-fetch-site', opts.secFetchSite);
	return {
		locals: { userId: null },
		url: new URL(`https://ankitalk.com${opts.path}`),
		cookies: { get: (name: string) => (name === 'hanko' ? opts.cookie : undefined) },
		request: new Request(`https://ankitalk.com${opts.path}`, { method: opts.method, headers }),
		platform: {
			env: { HANKO_API_URL: 'https://hanko.example', HANKO_AUDIENCE: 'aud', MEDIA: {}, KV: {} },
			context: { waitUntil: () => {} }
		}
	} as unknown as HandleArg['event'];
}

// Returns 'resolved' if the request passed the gate (resolve() ran), else the thrown status code.
async function run(event: HandleArg['event']): Promise<'resolved' | number> {
	const resolve = vi.fn(async () => RESOLVED);
	try {
		await handle({ event, resolve } as unknown as HandleArg);
		return resolve.mock.calls.length > 0 ? 'resolved' : -1;
	} catch (e) {
		return (e as { status?: number }).status ?? -1;
	}
}

const UPLOAD = '/api/media/upload/abc123def456';

describe('handle: capability-token upload bypass', () => {
	beforeEach(() => {
		verifyHankoToken.mockReset();
		first.mockReset();
	});

	it('lets an anonymous, header-less PUT reach the upload route (no 303, no 403)', async () => {
		verifyHankoToken.mockResolvedValue(null); // no session
		expect(await run(makeEvent({ method: 'PUT', path: UPLOAD }))).toBe('resolved');
	});

	it('lets the upload PUT through even with a cross-site Origin (CSRF guard exempted)', async () => {
		verifyHankoToken.mockResolvedValue(null);
		const r = await run(makeEvent({ method: 'PUT', path: UPLOAD, origin: 'https://evil.example', secFetchSite: 'cross-site' }));
		expect(r).toBe('resolved');
	});

	// --- Guard rails: the exemption must be narrow ---

	it('still redirects an anonymous request to a normal API route to /login (303)', async () => {
		verifyHankoToken.mockResolvedValue(null);
		expect(await run(makeEvent({ method: 'POST', path: '/api/notes' }))).toBe(303);
	});

	it('still gates the media SERVING path (/api/media/<file>), which is a different prefix', async () => {
		verifyHankoToken.mockResolvedValue(null);
		expect(await run(makeEvent({ method: 'GET', path: '/api/media/slide.png' }))).toBe(303);
	});

	it('does not exempt a look-alike prefix without the trailing slash', async () => {
		verifyHankoToken.mockResolvedValue(null);
		expect(await run(makeEvent({ method: 'PUT', path: '/api/media/upload-evil/x' }))).toBe(303);
	});

	it('keeps the same-origin CSRF guard working for authenticated mutating calls to other routes', async () => {
		verifyHankoToken.mockResolvedValue('hanko-1');
		first.mockResolvedValue({ id: 'user-1', updated_at: new Date().toISOString() });
		// Authenticated but cross-site -> still blocked by enforceSameOrigin.
		const blocked = await run(makeEvent({ method: 'POST', path: '/api/notes', secFetchSite: 'cross-site' }));
		expect(blocked).toBe(403);
		// Authenticated and same-origin -> allowed.
		const allowed = await run(makeEvent({ method: 'POST', path: '/api/notes', secFetchSite: 'same-origin' }));
		expect(allowed).toBe('resolved');
	});
});

import { error, redirect, type Handle, type HandleServerError } from '@sveltejs/kit';
import { getRemoteHankoJwks, verifyHankoToken } from '$lib/server/auth';
import { getDb, newId } from '$lib/server/db';

const PUBLIC_PATHS = ['/login'];
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Defense-in-depth CSRF: refuse mutating `/api/*` calls whose Origin doesn't match the
 * request host. SvelteKit's built-in `csrf.checkOrigin` already rejects cross-site posts
 * with form-encoded content types; this extends the check to JSON requests (which a
 * cross-site `fetch()` cannot send without a CORS preflight, but a misconfigured proxy
 * could). `Sec-Fetch-Site` is the modern signal; `Origin` is the fallback.
 */
function enforceSameOrigin(event: Parameters<Handle>[0]['event']) {
	if (!UNSAFE_METHODS.has(event.request.method)) return;
	if (!event.url.pathname.startsWith('/api/')) return;

	const fetchSite = event.request.headers.get('sec-fetch-site');
	if (fetchSite) {
		// Modern browsers always send this. "none" = directly typed URL (impossible for fetch),
		// "same-origin" = our own pages. Anything else (same-site, cross-site) is rejected.
		if (fetchSite !== 'same-origin') {
			throw error(403, 'Cross-origin request blocked');
		}
		return;
	}

	// Fallback for older clients: require Origin to match the request URL.
	const origin = event.request.headers.get('origin');
	if (!origin) {
		// No Origin and no Sec-Fetch-Site on a mutating API call is highly unusual — block.
		throw error(403, 'Origin required');
	}
	try {
		if (new URL(origin).origin !== event.url.origin) {
			throw error(403, 'Cross-origin request blocked');
		}
	} catch {
		throw error(403, 'Invalid origin');
	}
}

/**
 * Recommended baseline headers for any HTML/document response. We deliberately omit a CSP
 * here because Hanko Elements loads its own script + connects to the Hanko API; setting a
 * tight CSP requires testing the full Hanko allowlist and is the next iteration. The
 * headers below are pure wins with no runtime risk.
 */
const SECURITY_HEADERS: Record<string, string> = {
	'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
	'X-Frame-Options': 'DENY',
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	// Microphone is needed for voice review (Deepgram/ElevenLabs STT); nothing else.
	'Permissions-Policy': 'camera=(), microphone=(self), geolocation=(), interest-cohort=()'
};

/** Throttle `users.updated_at` to once per day per user — was firing on every request. */
const UPDATED_AT_TTL_SECONDS = 24 * 60 * 60;

/**
 * SvelteKit calls this for every *unexpected* error anywhere in the request lifecycle —
 * inside `handle`, inside an endpoint, or while streaming a response body. By default it
 * hides the cause behind `{"message":"Internal Error"}`. On staging we want the truth: log
 * the full error+stack (visible via `wrangler tail` / the Pages real-time log) and return the
 * real name+message in the body so the client surfaces it instead of an opaque 500. The
 * distinctive prefix also proves which build is live.
 */
export const handleError: HandleServerError = ({ error, event }) => {
	const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	console.error(`[handleError] ${event.request.method} ${event.url.pathname}:`, error);
	return { message: `Server error — ${detail}`.slice(0, 400) };
};

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.userId = null;
	// Remote MCP clients authenticate at the MCP route with their own scoped bearer
	// credential. They do not have (and must never need) the browser's Hanko cookie.
	// Keep this exact so token-management routes remain protected browser APIs.
	const isRemoteMcpEndpoint = event.url.pathname === '/api/mcp';

	const hankoApiUrl = event.platform?.env.HANKO_API_URL;
	if (!hankoApiUrl) {
		// No auth configured yet — allow passthrough for dev
		return resolve(event);
	}

	const token = event.cookies.get('hanko');
	const hankoId = await verifyHankoToken(token, {
		issuer: hankoApiUrl,
		audience: event.platform?.env.HANKO_AUDIENCE,
		jwks: getRemoteHankoJwks(hankoApiUrl)
	});

	if (hankoId) {
		const db = getDb(event.platform!);
		const kv = event.platform!.env.KV;
		const existing = await db
			.prepare('SELECT id FROM users WHERE hanko_id = ?')
			.bind(hankoId)
			.first<{ id: string }>();

		if (existing) {
			event.locals.userId = existing.id;
			// Skip the per-request `updated_at` write if we've already touched this user today.
			const touchKey = `user-touched:${existing.id}`;
			if (!(await kv.get(touchKey))) {
				event.platform!.context.waitUntil(
					(async () => {
						await db
							.prepare("UPDATE users SET updated_at = datetime('now') WHERE id = ?")
							.bind(existing.id)
							.run();
						await kv.put(touchKey, '1', { expirationTtl: UPDATED_AT_TTL_SECONDS });
					})().catch(() => undefined)
				);
			}
		} else {
			const userId = newId();
			await db
				.prepare('INSERT INTO users (id, hanko_id) VALUES (?, ?)')
				.bind(userId, hankoId)
				.run();
			event.locals.userId = userId;
		}
	}

	// Protect non-public paths
	const isPublic = PUBLIC_PATHS.some((p) => event.url.pathname.startsWith(p));
	if (!hankoId && !isPublic && !isRemoteMcpEndpoint) {
		throw redirect(303, '/login');
	}

	if (!isRemoteMcpEndpoint) enforceSameOrigin(event);

	const response = await resolve(event);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
		if (!response.headers.has(name)) response.headers.set(name, value);
	}
	return response;
};

import { error, redirect, type Handle, type HandleServerError } from '@sveltejs/kit';
import { getRemoteHankoJwks, verifyHankoToken } from '$lib/server/auth';
import { getDb, newId } from '$lib/server/db';

const PUBLIC_PATHS = ['/login'];
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Endpoints that remote OAuth/MCP clients call WITHOUT a browser session — discovery metadata,
 * dynamic client registration, the token exchange, and the MCP JSON-RPC endpoint itself. These
 * bypass both the login redirect (they authenticate via bearer token / PKCE, not the Hanko
 * cookie) and the same-origin guard (registration and token are legitimately cross-origin POSTs
 * from the client's servers). The /oauth/authorize consent page is deliberately NOT here: it
 * runs in the user's browser and must stay behind the Hanko session.
 */
function isPublicMcpEndpoint(pathname: string): boolean {
	return (
		pathname === '/api/mcp' ||
		pathname === '/api/mcp/oauth/register' ||
		pathname === '/api/mcp/oauth/token' ||
		pathname.startsWith('/.well-known/oauth-protected-resource') ||
		pathname.startsWith('/.well-known/oauth-authorization-server')
	);
}

/**
 * Direct media-upload endpoint. The unguessable capability token in the URL path IS the
 * credential — it's minted by an authenticated MCP call and validated in the route handler
 * (`consumeUploadToken`), not via the Hanko cookie. So, like the MCP endpoints, it must bypass
 * both the login redirect (a `curl` upload carries no session) and the cookie-CSRF guard (the
 * route reads no cookie, so a forged cross-site request gains nothing without the path token).
 */
function isCapabilityUploadEndpoint(pathname: string): boolean {
	return pathname.startsWith('/api/media/upload/');
}

/**
 * Same-origin CSRF guard. We disable SvelteKit's built-in `csrf.checkOrigin` (it has no
 * per-route opt-out and would block the legitimate cross-origin form POST to our OAuth token
 * endpoint), so this hook IS our CSRF protection. It covers every mutating request — both
 * `/api/*` calls and page form actions (e.g. the OAuth consent approve/deny) — and the caller
 * exempts only the public MCP/OAuth endpoints, which authenticate by bearer token / PKCE
 * instead. `Sec-Fetch-Site` is the modern signal; `Origin` is the fallback.
 */
function enforceSameOrigin(event: Parameters<Handle>[0]['event']) {
	if (!UNSAFE_METHODS.has(event.request.method)) return;

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

// `users.updated_at` is a coarse "last seen" timestamp; we only need it to advance once per day.
// We gate it on the `updated_at` value we already read with the user row (below) rather than on a
// per-request KV flag — that kept a KV read on the hot path of every authenticated request,
// including the ~100 cache-hit `/api/tts` subrequests a single review session fires.

/**
 * SvelteKit calls this for every *unexpected* error anywhere in the request lifecycle —
 * inside `handle`, inside an endpoint, or while streaming a response body. We log the full
 * error + stack server-side (visible via `wrangler tail` / the Pages real-time log) so the
 * cause is always recoverable, but return only a generic message to the client — the raw
 * error text can leak internals, so it stays in the logs.
 */
export const handleError: HandleServerError = ({ error, event }) => {
	console.error(`[handleError] ${event.request.method} ${event.url.pathname}:`, error);
	return { message: 'Internal Error' };
};

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.userId = null;
	// Remote MCP/OAuth clients authenticate at these routes with their own scoped bearer
	// credential (or PKCE), not the browser's Hanko cookie. Token-management routes and the
	// consent page are intentionally excluded so they stay protected browser surfaces.
	const isRemoteMcpEndpoint = isPublicMcpEndpoint(event.url.pathname);
	// Token-authed endpoints (MCP bearer/PKCE, or a capability token in the path) don't use the
	// Hanko cookie, so they skip the login redirect and the cookie-CSRF guard alike.
	const isTokenAuthedEndpoint = isRemoteMcpEndpoint || isCapabilityUploadEndpoint(event.url.pathname);

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
		const existing = await db
			.prepare('SELECT id, updated_at FROM users WHERE hanko_id = ?')
			.bind(hankoId)
			.first<{ id: string; updated_at: string }>();

		if (existing) {
			event.locals.userId = existing.id;
			// Advance `updated_at` at most once per UTC day, gated on the value we just read so the
			// write only fires when the day has rolled over — no per-request KV round-trip.
			if (existing.updated_at?.slice(0, 10) !== new Date().toISOString().slice(0, 10)) {
				event.platform!.context.waitUntil(
					db
						.prepare("UPDATE users SET updated_at = datetime('now') WHERE id = ?")
						.bind(existing.id)
						.run()
						.then(() => undefined)
						.catch(() => undefined)
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
	if (!hankoId && !isPublic && !isTokenAuthedEndpoint) {
		// Preserve where the user was headed (e.g. the OAuth consent page) so login can return
		// them there. Only same-origin relative paths are ever round-tripped (see login page).
		const target = event.url.pathname + event.url.search;
		const dest = target && target !== '/' ? `/login?redirect=${encodeURIComponent(target)}` : '/login';
		throw redirect(303, dest);
	}

	if (!isTokenAuthedEndpoint) enforceSameOrigin(event);

	const response = await resolve(event);

	const missing = Object.entries(SECURITY_HEADERS).filter(([name]) => !response.headers.has(name));
	if (missing.length === 0) return response;

	try {
		for (const [name, value] of missing) response.headers.set(name, value);
		return response;
	} catch {
		// Responses served straight from the Cloudflare edge cache (e.g. cached TTS audio in
		// /api/tts) — or any `fetch()` passthrough — have immutable headers, so `set()` throws
		// "Can't modify immutable headers" and SvelteKit collapses it into a 500. Rebuild a
		// mutable copy (the body stream is reused, not buffered) and add the headers there.
		const headers = new Headers(response.headers);
		for (const [name, value] of missing) headers.set(name, value);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers
		});
	}
};

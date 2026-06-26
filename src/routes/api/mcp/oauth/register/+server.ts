import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { registerClient } from '$lib/server/mcp/oauth';
import { enforceRateLimit } from '$lib/server/rate-limit';
import type { RequestHandler } from './$types';

/**
 * RFC 7591 Dynamic Client Registration. Open (unauthenticated) registration — MCP clients call
 * this before a human is ever in the loop — so it's rate-limited per client IP and only ever
 * mints a public PKCE client (no client secret, no implicit trust). The actual authorization
 * still requires a logged-in user to approve the consent screen, so an attacker registering a
 * client gains nothing on its own.
 */

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const MAX_REDIRECT_URIS = 10;

/** Allow https anywhere; allow http only for loopback (local client testing). */
function validRedirectUri(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > 2000) return false;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	if (parsed.protocol === 'https:') return true;
	if (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'))
		return true;
	return false;
}

export const OPTIONS: RequestHandler = async () => new Response(null, { status: 204, headers: CORS });

export const POST: RequestHandler = async ({ request, platform, getClientAddress }) => {
	let clientAddress = 'unknown';
	try {
		clientAddress = getClientAddress();
	} catch {
		// getClientAddress throws if it can't determine the IP; fall back to a shared bucket.
	}
	try {
		await enforceRateLimit(platform!.env.KV, clientAddress, 'oauth_register', 20, 60 * 60);
	} catch {
		return json(
			{ error: 'temporarily_unavailable', error_description: 'Too many registrations' },
			{ status: 429, headers: CORS }
		);
	}

	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body) {
		return json({ error: 'invalid_client_metadata' }, { status: 400, headers: CORS });
	}

	const redirectUrisRaw = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
	const redirectUris = redirectUrisRaw.filter(validRedirectUri).slice(0, MAX_REDIRECT_URIS);
	if (redirectUris.length === 0) {
		return json(
			{ error: 'invalid_redirect_uri', error_description: 'At least one https redirect_uri is required' },
			{ status: 400, headers: CORS }
		);
	}

	const db = getDb(platform!);
	const client = await registerClient(db, {
		client_name: typeof body.client_name === 'string' ? body.client_name : null,
		redirect_uris: redirectUris,
		grant_types: Array.isArray(body.grant_types)
			? (body.grant_types.filter((g) => typeof g === 'string') as string[])
			: undefined,
		token_endpoint_auth_method:
			typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none',
		scope: typeof body.scope === 'string' ? body.scope : null
	});

	// Echo back the registered metadata per RFC 7591. We don't issue a client secret (public
	// PKCE client), so there's nothing sensitive to return.
	return json(
		{
			client_id: client.client_id,
			client_name: client.client_name,
			redirect_uris: client.redirect_uris,
			grant_types: client.grant_types,
			token_endpoint_auth_method: client.token_endpoint_auth_method,
			scope: client.scope ?? undefined,
			client_id_issued_at: Math.floor(Date.now() / 1000)
		},
		{ status: 201, headers: { ...CORS, 'Cache-Control': 'no-store' } }
	);
};

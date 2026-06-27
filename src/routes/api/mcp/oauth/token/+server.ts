import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
	consumeAuthCode,
	getClient,
	issueTokensForGrant,
	redirectUriAllowed,
	refreshTokens,
	verifyPkceS256
} from '$lib/server/mcp/oauth';
import { parseScopes } from '$lib/server/mcp/auth';
import type { RequestHandler } from './$types';

/**
 * OAuth 2.1 token endpoint. Supports the two grants we advertise: `authorization_code`
 * (exchanging a consent-screen code + PKCE verifier for tokens) and `refresh_token` (rotating
 * an expired access token). Public clients only — no client authentication, security comes from
 * PKCE and the single-use, client-bound authorization code.
 */

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};
const NO_STORE = { ...CORS, 'Cache-Control': 'no-store' };

function oauthError(error: string, description: string, status = 400) {
	return json({ error, error_description: description }, { status, headers: NO_STORE });
}

/**
 * Log a token-grant failure server-side (visible via `wrangler pages deployment tail`) while
 * returning only the standard OAuth error to the client. The `reason` pinpoints which check
 * failed — invaluable when a client like Claude only surfaces a generic "Authorization failed".
 */
function fail(reason: string, error: string, description: string, status = 400) {
	console.error(`[oauth/token] ${reason}`);
	return oauthError(error, description, status);
}

export const OPTIONS: RequestHandler = async () => new Response(null, { status: 204, headers: CORS });

export const POST: RequestHandler = async ({ request, platform }) => {
	try {
		const form = await request.formData().catch(() => null);
		if (!form) return fail('non-form body', 'invalid_request', 'Expected form-encoded body');

		const grantType = String(form.get('grant_type') ?? '');
		const db = getDb(platform!);

		if (grantType === 'authorization_code') {
			const code = String(form.get('code') ?? '');
			const clientId = String(form.get('client_id') ?? '');
			const redirectUri = String(form.get('redirect_uri') ?? '');
			const codeVerifier = String(form.get('code_verifier') ?? '');

			if (!code || !clientId || !redirectUri || !codeVerifier) {
				return fail(
					`missing param (code=${!!code} client_id=${!!clientId} redirect_uri=${!!redirectUri} verifier=${!!codeVerifier})`,
					'invalid_request',
					'Missing required parameter'
				);
			}

			const client = await getClient(db, clientId);
			if (!client) return fail(`unknown client ${clientId}`, 'invalid_client', 'Unknown client', 401);

			const record = await consumeAuthCode(db, code);
			// The code is deleted by consumeAuthCode whether or not it validated, so every check
			// below fails closed and a replay finds nothing.
			if (!record) return fail('code not found/expired', 'invalid_grant', 'Authorization code is invalid or expired');
			if (record.client_id !== clientId) {
				return fail(`code client mismatch (${record.client_id} != ${clientId})`, 'invalid_grant', 'Code was issued to another client');
			}
			if (record.redirect_uri !== redirectUri || !redirectUriAllowed(client, redirectUri)) {
				return fail(
					`redirect_uri mismatch (req=${redirectUri} stored=${record.redirect_uri} registered=${client.redirect_uris.join('|')})`,
					'invalid_grant',
					'redirect_uri mismatch'
				);
			}
			if (!(await verifyPkceS256(codeVerifier, record.code_challenge))) {
				return fail('PKCE verification failed', 'invalid_grant', 'PKCE verification failed');
			}

			const tokens = await issueTokensForGrant(db, {
				userId: record.user_id,
				clientId,
				scopes: [...parseScopes(record.scope)]
			});
			return json({ token_type: 'Bearer', ...tokens }, { headers: NO_STORE });
		}

		if (grantType === 'refresh_token') {
			const refreshToken = String(form.get('refresh_token') ?? '');
			const clientId = String(form.get('client_id') ?? '');
			if (!refreshToken || !clientId) return fail('missing refresh param', 'invalid_request', 'Missing required parameter');

			const client = await getClient(db, clientId);
			if (!client) return fail(`unknown client ${clientId}`, 'invalid_client', 'Unknown client', 401);

			const tokens = await refreshTokens(db, { refreshToken, clientId });
			if (!tokens) return fail('refresh token invalid/expired', 'invalid_grant', 'Refresh token is invalid or expired');
			return json({ token_type: 'Bearer', ...tokens }, { headers: NO_STORE });
		}

		return fail(`unsupported grant_type ${grantType}`, 'unsupported_grant_type', `Unsupported grant_type: ${grantType}`);
	} catch (err) {
		// A thrown error here (e.g. a DB write against a half-applied schema) would otherwise
		// surface as a bare 500 that Claude reports as a generic authorization failure. Log the
		// detail and return a spec-compliant error so the cause is recoverable from the logs.
		console.error('[oauth/token] unexpected error', err);
		return oauthError('server_error', 'Token endpoint failed', 500);
	}
};

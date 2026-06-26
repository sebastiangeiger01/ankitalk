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

export const OPTIONS: RequestHandler = async () => new Response(null, { status: 204, headers: CORS });

export const POST: RequestHandler = async ({ request, platform }) => {
	const form = await request.formData().catch(() => null);
	if (!form) return oauthError('invalid_request', 'Expected form-encoded body');

	const grantType = String(form.get('grant_type') ?? '');
	const db = getDb(platform!);

	if (grantType === 'authorization_code') {
		const code = String(form.get('code') ?? '');
		const clientId = String(form.get('client_id') ?? '');
		const redirectUri = String(form.get('redirect_uri') ?? '');
		const codeVerifier = String(form.get('code_verifier') ?? '');

		if (!code || !clientId || !redirectUri || !codeVerifier) {
			return oauthError('invalid_request', 'Missing required parameter');
		}

		const client = await getClient(db, clientId);
		if (!client) return oauthError('invalid_client', 'Unknown client', 401);

		const record = await consumeAuthCode(db, code);
		// The code is deleted by consumeAuthCode whether or not it validated, so every check
		// below fails closed and a replay finds nothing.
		if (!record) return oauthError('invalid_grant', 'Authorization code is invalid or expired');
		if (record.client_id !== clientId) return oauthError('invalid_grant', 'Code was issued to another client');
		if (record.redirect_uri !== redirectUri || !redirectUriAllowed(client, redirectUri)) {
			return oauthError('invalid_grant', 'redirect_uri mismatch');
		}
		if (!(await verifyPkceS256(codeVerifier, record.code_challenge))) {
			return oauthError('invalid_grant', 'PKCE verification failed');
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
		if (!refreshToken || !clientId) return oauthError('invalid_request', 'Missing required parameter');

		const client = await getClient(db, clientId);
		if (!client) return oauthError('invalid_client', 'Unknown client', 401);

		const tokens = await refreshTokens(db, { refreshToken, clientId });
		if (!tokens) return oauthError('invalid_grant', 'Refresh token is invalid or expired');
		return json({ token_type: 'Bearer', ...tokens }, { headers: NO_STORE });
	}

	return oauthError('unsupported_grant_type', `Unsupported grant_type: ${grantType}`);
};

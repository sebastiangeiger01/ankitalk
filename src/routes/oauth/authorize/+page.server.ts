import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
	createAuthCode,
	getClient,
	redirectUriAllowed,
	sanitizeScopeString
} from '$lib/server/mcp/oauth';
import type { McpScope } from '$lib/server/mcp/auth';
import type { Actions, PageServerLoad } from './$types';

/**
 * OAuth consent screen. Reached only once the user is signed in (hooks.server.ts redirects
 * anonymous visitors to /login and back), so the "who is approving" question is already
 * answered by their AnkiTalk session. Here they decide whether the requesting client (e.g.
 * Claude) may read their cards and — optionally — author new ones.
 */

// We only ever grant scopes that map to real MCP tools. Reads are always part of a grant;
// card authoring is opt-in via the consent toggle.
const READ_SCOPES: McpScope[] = ['cards:read', 'study:read'];
const WRITE_SCOPE: McpScope = 'cards:write';

function buildRedirect(redirectUri: string, params: Record<string, string | null>): string {
	const url = new URL(redirectUri);
	for (const [key, value] of Object.entries(params)) {
		if (value !== null && value !== '') url.searchParams.set(key, value);
	}
	return url.toString();
}

export const load: PageServerLoad = async ({ url, locals, platform }) => {
	// Defensive: hooks should have redirected anonymous users already.
	if (!locals.userId) throw redirect(303, `/login?redirect=${encodeURIComponent(url.pathname + url.search)}`);

	const clientId = url.searchParams.get('client_id') ?? '';
	const redirectUri = url.searchParams.get('redirect_uri') ?? '';
	const responseType = url.searchParams.get('response_type') ?? '';
	const codeChallenge = url.searchParams.get('code_challenge') ?? '';
	const codeChallengeMethod = url.searchParams.get('code_challenge_method') ?? '';
	const state = url.searchParams.get('state') ?? '';
	const scope = url.searchParams.get('scope') ?? '';
	const resource = url.searchParams.get('resource') ?? '';

	const db = getDb(platform!);
	const client = await getClient(db, clientId);

	// Errors we can't safely redirect (untrusted/unknown redirect target) are shown inline.
	if (!client || !redirectUri || !redirectUriAllowed(client, redirectUri)) {
		return { invalid: 'invalid_client' as const };
	}
	// From here the redirect_uri is trusted, so protocol errors bounce back to the client.
	if (responseType !== 'code') {
		throw redirect(303, buildRedirect(redirectUri, { error: 'unsupported_response_type', state }));
	}
	if (!codeChallenge || codeChallengeMethod !== 'S256') {
		throw redirect(303, buildRedirect(redirectUri, { error: 'invalid_request', error_description: 'PKCE S256 required', state }));
	}

	const requested = sanitizeScopeString(scope);
	const writeRequested = requested.length === 0 || requested.includes(WRITE_SCOPE);

	return {
		invalid: null,
		client: { id: client.client_id, name: client.client_name },
		writeRequested,
		// Echoed straight back to the approve/deny actions as hidden fields.
		params: { clientId, redirectUri, codeChallenge, state, scope, resource }
	};
};

export const actions: Actions = {
	approve: async ({ request, locals, platform }) => {
		if (!locals.userId) throw redirect(303, '/login');
		const form = await request.formData();
		const clientId = String(form.get('client_id') ?? '');
		const redirectUri = String(form.get('redirect_uri') ?? '');
		const codeChallenge = String(form.get('code_challenge') ?? '');
		const state = String(form.get('state') ?? '');
		const resource = String(form.get('resource') ?? '') || null;
		const allowWrite = form.get('allow_write') === 'on';

		const db = getDb(platform!);
		const client = await getClient(db, clientId);
		if (!client || !redirectUriAllowed(client, redirectUri) || !codeChallenge) {
			throw redirect(303, '/settings');
		}

		const scopes: McpScope[] = allowWrite ? [...READ_SCOPES, WRITE_SCOPE] : [...READ_SCOPES];
		const code = await createAuthCode(db, {
			clientId,
			userId: locals.userId,
			redirectUri,
			codeChallenge,
			scopes,
			resource
		});
		throw redirect(303, buildRedirect(redirectUri, { code, state }));
	},

	deny: async ({ request, platform }) => {
		const form = await request.formData();
		const clientId = String(form.get('client_id') ?? '');
		const redirectUri = String(form.get('redirect_uri') ?? '');
		const state = String(form.get('state') ?? '');

		const db = getDb(platform!);
		const client = await getClient(db, clientId);
		if (!client || !redirectUriAllowed(client, redirectUri)) throw redirect(303, '/settings');
		throw redirect(303, buildRedirect(redirectUri, { error: 'access_denied', state }));
	}
};

import { newId } from '$lib/server/db';
import { hashToken, MCP_SCOPES, serializeScopes, parseScopes, type McpScope } from './auth';

/**
 * OAuth 2.1 (Authorization Code + PKCE) support for the MCP endpoint. Clients that can't use
 * a static bearer token — Claude's custom connectors in particular — discover these endpoints,
 * register dynamically (RFC 7591), send the user through the consent screen, and exchange an
 * authorization code for an access + refresh token.
 *
 * Access tokens are stored as `mcp_tokens` rows (kind='oauth') so the existing
 * `resolveTokenOwner` lookup authenticates them with no extra code path. See migration 0017.
 */

// Public-client config: short-lived access tokens, long-lived rotating refresh tokens, and
// authorization codes valid only long enough to complete the redirect round trip.
const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL_SECONDS = 10 * 60; // 10 minutes

// Token/code prefixes. Access tokens MUST keep the `mcp_` prefix so `resolveTokenOwner`'s
// prefix guard accepts them.
const ACCESS_PREFIX = 'mcp_';
const REFRESH_PREFIX = 'mcp_rt_';
const CODE_PREFIX = 'mcp_ac_';

export interface OAuthClient {
	client_id: string;
	client_name: string | null;
	redirect_uris: string[];
	grant_types: string[];
	token_endpoint_auth_method: string;
	scope: string | null;
}

export interface IssuedTokens {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	scope: string;
}

function iso(secondsFromNow: number): string {
	return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

/** A random opaque secret with a recognizable prefix; 24 bytes = 192 bits of entropy. */
function randomSecret(prefix: string): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Verify a PKCE code_verifier against the stored S256 challenge. Constant-ish time isn't
 * critical here because the challenge is single-use and bound to one short-lived code, but we
 * compare the full computed value rather than a prefix.
 */
export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
	if (!verifier || !challenge) return false;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return base64UrlEncode(new Uint8Array(digest)) === challenge;
}

/** Keep only scopes we actually recognize; fall back is handled by the caller. */
export function sanitizeScopeString(scope: string | null | undefined): McpScope[] {
	const requested = (scope ?? '')
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter((s): s is McpScope => MCP_SCOPES.includes(s as McpScope));
	return [...new Set(requested)];
}

// ---------------------------------------------------------------------------
// Dynamic client registration
// ---------------------------------------------------------------------------

export async function registerClient(
	db: D1Database,
	input: {
		client_name?: string | null;
		redirect_uris: string[];
		grant_types?: string[];
		token_endpoint_auth_method?: string;
		scope?: string | null;
	}
): Promise<OAuthClient> {
	const clientId = newId();
	const grantTypes = input.grant_types?.length
		? input.grant_types
		: ['authorization_code', 'refresh_token'];
	const client: OAuthClient = {
		client_id: clientId,
		client_name: input.client_name?.slice(0, 200) ?? null,
		redirect_uris: input.redirect_uris,
		grant_types: grantTypes,
		token_endpoint_auth_method: input.token_endpoint_auth_method || 'none',
		scope: input.scope ?? null
	};
	await db
		.prepare(
			`INSERT INTO mcp_oauth_clients
			 (client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method, scope)
			 VALUES (?, ?, ?, ?, ?, ?)`
		)
		.bind(
			client.client_id,
			client.client_name,
			JSON.stringify(client.redirect_uris),
			client.grant_types.join(','),
			client.token_endpoint_auth_method,
			client.scope
		)
		.run();
	return client;
}

export async function getClient(db: D1Database, clientId: string): Promise<OAuthClient | null> {
	if (!clientId) return null;
	const row = await db
		.prepare(
			`SELECT client_id, client_name, redirect_uris, grant_types, token_endpoint_auth_method, scope
			 FROM mcp_oauth_clients WHERE client_id = ?`
		)
		.bind(clientId)
		.first<{
			client_id: string;
			client_name: string | null;
			redirect_uris: string;
			grant_types: string;
			token_endpoint_auth_method: string;
			scope: string | null;
		}>();
	if (!row) return null;
	let redirectUris: string[] = [];
	try {
		redirectUris = JSON.parse(row.redirect_uris);
	} catch {
		redirectUris = [];
	}
	return {
		client_id: row.client_id,
		client_name: row.client_name,
		redirect_uris: redirectUris,
		grant_types: row.grant_types.split(',').filter(Boolean),
		token_endpoint_auth_method: row.token_endpoint_auth_method,
		scope: row.scope
	};
}

/** An exact, case-sensitive match is required between the request and a registered URI. */
export function redirectUriAllowed(client: OAuthClient, redirectUri: string): boolean {
	return client.redirect_uris.includes(redirectUri);
}

// ---------------------------------------------------------------------------
// Authorization codes
// ---------------------------------------------------------------------------

export async function createAuthCode(
	db: D1Database,
	input: {
		clientId: string;
		userId: string;
		redirectUri: string;
		codeChallenge: string;
		scopes: McpScope[];
		resource: string | null;
	}
): Promise<string> {
	const code = randomSecret(CODE_PREFIX);
	const codeHash = await hashToken(code);
	await db
		.prepare(
			`INSERT INTO mcp_oauth_codes
			 (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			codeHash,
			input.clientId,
			input.userId,
			input.redirectUri,
			input.codeChallenge,
			serializeScopes(input.scopes),
			input.resource,
			iso(CODE_TTL_SECONDS)
		)
		.run();
	return code;
}

export interface AuthCodeRecord {
	client_id: string;
	user_id: string;
	redirect_uri: string;
	code_challenge: string;
	scope: string;
	resource: string | null;
}

/** Look up and atomically delete (single-use) a still-valid authorization code. */
export async function consumeAuthCode(
	db: D1Database,
	code: string
): Promise<AuthCodeRecord | null> {
	if (!code || !code.startsWith(CODE_PREFIX)) return null;
	const codeHash = await hashToken(code);
	const row = await db
		.prepare(
			`SELECT client_id, user_id, redirect_uri, code_challenge, scope, resource
			 FROM mcp_oauth_codes
			 WHERE code_hash = ? AND expires_at > datetime('now')`
		)
		.bind(codeHash)
		.first<AuthCodeRecord>();
	// Delete regardless of validity window so a leaked-but-expired code can't linger.
	await db.prepare('DELETE FROM mcp_oauth_codes WHERE code_hash = ?').bind(codeHash).run();
	return row ?? null;
}

// ---------------------------------------------------------------------------
// Access + refresh tokens (stored as kind='oauth' rows in mcp_tokens)
// ---------------------------------------------------------------------------

async function writeTokenRow(
	db: D1Database,
	input: {
		id: string;
		userId: string;
		clientId: string;
		accessHash: string;
		accessPrefix: string;
		refreshHash: string;
		scopeSerialized: string;
		isInsert: boolean;
	}
): Promise<void> {
	if (input.isInsert) {
		await db
			.prepare(
				`INSERT INTO mcp_tokens
				 (id, user_id, token_hash, prefix, label, scopes, kind, client_id,
				  refresh_token_hash, expires_at, refresh_expires_at, created_at)
				 VALUES (?, ?, ?, ?, NULL, ?, 'oauth', ?, ?, ?, ?, datetime('now'))`
			)
			.bind(
				input.id,
				input.userId,
				input.accessHash,
				input.accessPrefix,
				input.scopeSerialized,
				input.clientId,
				input.refreshHash,
				iso(ACCESS_TTL_SECONDS),
				iso(REFRESH_TTL_SECONDS)
			)
			.run();
	} else {
		await db
			.prepare(
				`UPDATE mcp_tokens
				 SET token_hash = ?, prefix = ?, refresh_token_hash = ?, scopes = ?,
				     expires_at = ?, refresh_expires_at = ?, last_used_at = datetime('now')
				 WHERE id = ?`
			)
			.bind(
				input.accessHash,
				input.accessPrefix,
				input.refreshHash,
				input.scopeSerialized,
				iso(ACCESS_TTL_SECONDS),
				iso(REFRESH_TTL_SECONDS),
				input.id
			)
			.run();
	}
}

/** Mint a fresh access+refresh pair for a brand-new grant (after code exchange). */
export async function issueTokensForGrant(
	db: D1Database,
	input: { userId: string; clientId: string; scopes: McpScope[] }
): Promise<IssuedTokens> {
	const access = randomSecret(ACCESS_PREFIX);
	const refresh = randomSecret(REFRESH_PREFIX);
	const scopeSerialized = serializeScopes(input.scopes);
	await writeTokenRow(db, {
		id: newId(),
		userId: input.userId,
		clientId: input.clientId,
		accessHash: await hashToken(access),
		accessPrefix: access.slice(0, ACCESS_PREFIX.length + 8),
		refreshHash: await hashToken(refresh),
		scopeSerialized,
		isInsert: true
	});
	return {
		access_token: access,
		refresh_token: refresh,
		expires_in: ACCESS_TTL_SECONDS,
		scope: scopeSerialized.split(',').join(' ')
	};
}

/**
 * Rotate an access+refresh pair given a presented refresh token. Refresh-token rotation: the
 * old refresh token is invalidated and a new one issued, so a stolen refresh token is usable
 * at most until the legitimate client next refreshes. Returns null if the refresh token is
 * unknown, expired, or belongs to a different client.
 */
export async function refreshTokens(
	db: D1Database,
	input: { refreshToken: string; clientId: string }
): Promise<IssuedTokens | null> {
	if (!input.refreshToken || !input.refreshToken.startsWith(REFRESH_PREFIX)) return null;
	const refreshHash = await hashToken(input.refreshToken);
	const row = await db
		.prepare(
			`SELECT id, user_id, scopes, client_id
			 FROM mcp_tokens
			 WHERE refresh_token_hash = ? AND kind = 'oauth'
			   AND (refresh_expires_at IS NULL OR refresh_expires_at > datetime('now'))`
		)
		.bind(refreshHash)
		.first<{ id: string; user_id: string; scopes: string; client_id: string | null }>();
	if (!row || row.client_id !== input.clientId) return null;

	const access = randomSecret(ACCESS_PREFIX);
	const refresh = randomSecret(REFRESH_PREFIX);
	const scopeSerialized = serializeScopes([...parseScopes(row.scopes)]);
	await writeTokenRow(db, {
		id: row.id,
		userId: row.user_id,
		clientId: input.clientId,
		accessHash: await hashToken(access),
		accessPrefix: access.slice(0, ACCESS_PREFIX.length + 8),
		refreshHash: await hashToken(refresh),
		scopeSerialized,
		isInsert: false
	});
	return {
		access_token: access,
		refresh_token: refresh,
		expires_in: ACCESS_TTL_SECONDS,
		scope: scopeSerialized.split(',').join(' ')
	};
}

// ---------------------------------------------------------------------------
// Discovery metadata
// ---------------------------------------------------------------------------

export function protectedResourceMetadata(origin: string) {
	return {
		resource: `${origin}/api/mcp`,
		authorization_servers: [origin],
		scopes_supported: [...MCP_SCOPES],
		bearer_methods_supported: ['header'],
		resource_documentation: `${origin}/settings`
	};
}

export function authorizationServerMetadata(origin: string) {
	return {
		issuer: origin,
		authorization_endpoint: `${origin}/oauth/authorize`,
		token_endpoint: `${origin}/api/mcp/oauth/token`,
		registration_endpoint: `${origin}/api/mcp/oauth/register`,
		scopes_supported: [...MCP_SCOPES],
		response_types_supported: ['code'],
		response_modes_supported: ['query'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		token_endpoint_auth_methods_supported: ['none'],
		code_challenge_methods_supported: ['S256']
	};
}

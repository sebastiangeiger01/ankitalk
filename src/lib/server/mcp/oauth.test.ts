// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
	authorizationServerMetadata,
	protectedResourceMetadata,
	redirectUriAllowed,
	sanitizeScopeString,
	verifyPkceS256,
	type OAuthClient
} from './oauth';

describe('verifyPkceS256', () => {
	// Canonical example from RFC 7636 Appendix B.
	const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
	const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

	it('accepts the matching verifier/challenge pair', async () => {
		expect(await verifyPkceS256(verifier, challenge)).toBe(true);
	});

	it('rejects a mismatched verifier', async () => {
		expect(await verifyPkceS256('not-the-verifier', challenge)).toBe(false);
	});

	it('rejects empty input', async () => {
		expect(await verifyPkceS256('', challenge)).toBe(false);
		expect(await verifyPkceS256(verifier, '')).toBe(false);
	});
});

describe('sanitizeScopeString', () => {
	it('keeps only recognized scopes and dedupes', () => {
		expect(sanitizeScopeString('cards:read cards:read admin cards:write').sort()).toEqual([
			'cards:read',
			'cards:write'
		]);
	});

	it('accepts comma or space separators', () => {
		expect(sanitizeScopeString('cards:read,study:read').sort()).toEqual(['cards:read', 'study:read']);
	});

	it('returns empty for null/garbage', () => {
		expect(sanitizeScopeString(null)).toEqual([]);
		expect(sanitizeScopeString('nonsense')).toEqual([]);
	});
});

describe('redirectUriAllowed', () => {
	const client: OAuthClient = {
		client_id: 'c1',
		client_name: 'Claude',
		redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
		grant_types: ['authorization_code'],
		token_endpoint_auth_method: 'none',
		scope: null
	};

	it('requires an exact match', () => {
		expect(redirectUriAllowed(client, 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
		expect(redirectUriAllowed(client, 'https://claude.ai/api/mcp/auth_callback/')).toBe(false);
		expect(redirectUriAllowed(client, 'https://evil.example/cb')).toBe(false);
	});
});

describe('discovery metadata', () => {
	it('PRM points at the MCP resource and this origin as the AS', () => {
		const m = protectedResourceMetadata('https://ankitalk.app');
		expect(m.resource).toBe('https://ankitalk.app/api/mcp');
		expect(m.authorization_servers).toEqual(['https://ankitalk.app']);
	});

	it('AS metadata advertises PKCE S256 and our endpoints', () => {
		const m = authorizationServerMetadata('https://ankitalk.app');
		expect(m.authorization_endpoint).toBe('https://ankitalk.app/oauth/authorize');
		expect(m.token_endpoint).toBe('https://ankitalk.app/api/mcp/oauth/token');
		expect(m.registration_endpoint).toBe('https://ankitalk.app/api/mcp/oauth/register');
		expect(m.code_challenge_methods_supported).toEqual(['S256']);
	});
});

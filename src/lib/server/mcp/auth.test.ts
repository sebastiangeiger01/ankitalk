// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { extractBearer, generateToken, hashToken, parseScopes, serializeScopes } from './auth';

describe('extractBearer', () => {
	it('returns the token from a well-formed Bearer header', () => {
		expect(extractBearer('Bearer mcp_abc123')).toBe('mcp_abc123');
		// Case-insensitive scheme per RFC 6750.
		expect(extractBearer('bearer mcp_abc123')).toBe('mcp_abc123');
	});

	it('returns null for missing or malformed headers', () => {
		expect(extractBearer(null)).toBeNull();
		expect(extractBearer('')).toBeNull();
		expect(extractBearer('Basic foo')).toBeNull();
		expect(extractBearer('Bearer ')).toBeNull();
		expect(extractBearer('Bearer  ')).toBeNull();
	});
});

describe('generateToken', () => {
	it('produces an mcp_-prefixed 48-hex body', async () => {
		const t = await generateToken();
		expect(t.plaintext).toMatch(/^mcp_[0-9a-f]{48}$/);
		expect(t.prefix).toBe(t.plaintext.slice(0, 12));
	});

	it('hash matches the live SHA-256 of the plaintext', async () => {
		const t = await generateToken();
		expect(await hashToken(t.plaintext)).toBe(t.hash);
	});

	it('each call returns a fresh value (collisions astronomically unlikely)', async () => {
		const a = await generateToken();
		const b = await generateToken();
		expect(a.plaintext).not.toBe(b.plaintext);
		expect(a.hash).not.toBe(b.hash);
	});
});

describe('MCP scopes', () => {
	it('parses only supported scopes', () => {
		expect([...parseScopes('cards:write,cards:read,admin')].sort()).toEqual(['cards:read', 'cards:write']);
	});

	it('defaults old tokens to read-only scopes', () => {
		expect([...parseScopes(null)].sort()).toEqual(['cards:read', 'study:read']);
	});

	it('serializes scopes deterministically', () => {
		expect(serializeScopes(['study:read', 'cards:read', 'study:read'])).toBe('cards:read,study:read');
	});
});

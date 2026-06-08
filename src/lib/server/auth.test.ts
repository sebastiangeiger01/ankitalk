// @vitest-environment node
// jose's internal `instanceof Uint8Array` checks fail under jsdom because TextEncoder
// returns a Uint8Array from a different realm. Run this file in plain node.
import { describe, expect, it } from 'vitest';
import * as jose from 'jose';
import { verifyHankoToken } from './auth';

/** Build a fake Hanko tenant: a real RSA keypair + a local JWKS resolver to inject. */
async function makeTenant() {
	const { publicKey, privateKey } = await jose.generateKeyPair('RS256', { extractable: true });
	const jwk = await jose.exportJWK(publicKey);
	jwk.kid = 'test-key';
	jwk.alg = 'RS256';
	jwk.use = 'sig';

	const jwks = jose.createLocalJWKSet({ keys: [jwk as jose.JWK] });

	async function sign(opts: { issuer?: string; audience?: string } = {}) {
		const builder = new jose.SignJWT({})
			.setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
			.setSubject('hanko-user-1')
			.setExpirationTime('1h');
		if (opts.issuer !== undefined) builder.setIssuer(opts.issuer);
		if (opts.audience !== undefined) builder.setAudience(opts.audience);
		return builder.sign(privateKey);
	}

	return { sign, jwks };
}

const ISSUER = 'https://tenant.hanko.io';

describe('verifyHankoToken', () => {
	it('returns sub when token has the expected issuer', async () => {
		const { sign, jwks } = await makeTenant();
		const token = await sign({ issuer: ISSUER });
		expect(await verifyHankoToken(token, { issuer: ISSUER, jwks })).toBe('hanko-user-1');
	});

	it('rejects a token signed by the same key but issued by a different tenant', async () => {
		const { sign, jwks } = await makeTenant();
		const token = await sign({ issuer: 'https://other.hanko.io' });
		expect(await verifyHankoToken(token, { issuer: ISSUER, jwks })).toBeNull();
	});

	it('rejects a token with no issuer claim', async () => {
		const { sign, jwks } = await makeTenant();
		const token = await sign();
		expect(await verifyHankoToken(token, { issuer: ISSUER, jwks })).toBeNull();
	});

	it('rejects a token whose audience differs when audience is required', async () => {
		const { sign, jwks } = await makeTenant();
		const token = await sign({ issuer: ISSUER, audience: 'https://attacker.example' });
		expect(
			await verifyHankoToken(token, { issuer: ISSUER, audience: 'https://app.example', jwks })
		).toBeNull();
	});

	it('accepts a token with the expected audience', async () => {
		const { sign, jwks } = await makeTenant();
		const token = await sign({ issuer: ISSUER, audience: 'https://app.example' });
		expect(
			await verifyHankoToken(token, { issuer: ISSUER, audience: 'https://app.example', jwks })
		).toBe('hanko-user-1');
	});

	it('rejects a token signed by a different keypair (rotation / wrong tenant)', async () => {
		const { jwks } = await makeTenant();
		const { sign: signOther } = await makeTenant();
		const token = await signOther({ issuer: ISSUER });
		expect(await verifyHankoToken(token, { issuer: ISSUER, jwks })).toBeNull();
	});

	it('returns null for missing or empty tokens', async () => {
		const { jwks } = await makeTenant();
		expect(await verifyHankoToken(undefined, { issuer: ISSUER, jwks })).toBeNull();
		expect(await verifyHankoToken('', { issuer: ISSUER, jwks })).toBeNull();
	});
});

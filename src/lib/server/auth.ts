import * as jose from 'jose';

/** Key resolver shape jose's `jwtVerify` expects — local or remote, indistinguishable to us. */
export type Jwks = Parameters<typeof jose.jwtVerify>[1];

// Cache the remote JWKS per tenant URL so misconfiguration or env switches don't bleed keys
// across tenants.
const remoteJwksByIssuer = new Map<string, Jwks>();

/**
 * Build (and memoize) a remote JWKS resolver for a Hanko tenant. Tests inject their own
 * `Jwks` so this never has to be mocked.
 */
export function getRemoteHankoJwks(hankoApiUrl: string): Jwks {
	let entry = remoteJwksByIssuer.get(hankoApiUrl);
	if (!entry) {
		entry = jose.createRemoteJWKSet(new URL(`${hankoApiUrl}/.well-known/jwks.json`));
		remoteJwksByIssuer.set(hankoApiUrl, entry);
	}
	return entry;
}

export interface VerifyOptions {
	/** Expected `iss` claim. We always require this so tokens from another Hanko tenant
	 * (or any other issuer signed by a compromised co-tenant key) are rejected. */
	issuer: string;
	/** Optional expected `aud` claim. Hanko tokens carry the app/frontend URL as the audience;
	 * set via `HANKO_AUDIENCE` to additionally constrain which app's tokens this server accepts.
	 * Left unset, audience is not validated (only signature, expiry and issuer). */
	audience?: string;
	/** Override the JWKS resolver (tests inject a local one). Defaults to the remote tenant set. */
	jwks?: Jwks;
}

/**
 * Verify a Hanko JWT token and return the subject (Hanko user ID).
 * Returns null if the token is invalid, missing, or fails issuer/audience checks.
 */
export async function verifyHankoToken(
	token: string | undefined,
	options: VerifyOptions
): Promise<string | null> {
	if (!token) return null;

	try {
		const verifyOpts: jose.JWTVerifyOptions = { issuer: options.issuer };
		if (options.audience) verifyOpts.audience = options.audience;
		const jwks = options.jwks ?? getRemoteHankoJwks(options.issuer);
		const { payload } = await jose.jwtVerify(token, jwks, verifyOpts);
		return payload.sub ?? null;
	} catch {
		return null;
	}
}

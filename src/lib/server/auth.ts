import * as jose from 'jose';

let jwks: ReturnType<typeof jose.createRemoteJWKSet> | null = null;

function getJwks(hankoApiUrl: string) {
	if (!jwks) {
		jwks = jose.createRemoteJWKSet(new URL(`${hankoApiUrl}/.well-known/jwks.json`));
	}
	return jwks;
}

/**
 * Verify a Hanko JWT token and return the subject (Hanko user ID).
 * Returns null if the token is invalid or missing.
 */
export async function verifyHankoToken(
	token: string | undefined,
	hankoApiUrl: string
): Promise<string | null> {
	if (!token) return null;

	try {
		const { payload } = await jose.jwtVerify(token, getJwks(hankoApiUrl));
		return payload.sub ?? null;
	} catch {
		return null;
	}
}

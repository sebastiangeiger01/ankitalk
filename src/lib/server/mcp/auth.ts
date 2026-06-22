import { newId } from '$lib/server/db';

/**
 * MCP bearer token format: `mcp_<48 hex chars>`. The prefix lets the user instantly
 * recognize what kind of secret they're looking at; the 48-hex-char body is 192 bits
 * of randomness, well above what we'd ever need.
 */
const TOKEN_PREFIX = 'mcp_';
const TOKEN_BYTES = 24; // → 48 hex chars

export interface McpTokenRow {
	id: string;
	user_id: string;
	token_hash: string;
	prefix: string;
	label: string | null;
	last_used_at: string | null;
	created_at: string;
}

/** Generate a fresh token. The plaintext is returned ONCE; only the hash is persisted. */
export async function generateToken(): Promise<{ plaintext: string; hash: string; prefix: string }> {
	const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
	const body = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	const plaintext = TOKEN_PREFIX + body;
	const hash = await hashToken(plaintext);
	return { plaintext, hash, prefix: plaintext.slice(0, TOKEN_PREFIX.length + 8) };
}

/** SHA-256 hex of the plaintext token — cheap, collision-resistant, no salt needed. */
export async function hashToken(plaintext: string): Promise<string> {
	const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(plaintext));
	return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Pull a Bearer token out of an Authorization header. */
export function extractBearer(authHeader: string | null): string | null {
	if (!authHeader) return null;
	const match = authHeader.match(/^Bearer\s+(\S+)$/i);
	return match ? match[1] : null;
}

/**
 * Validate a presented token: look up by hash, return the owning user_id on hit. We
 * also update `last_used_at` opportunistically (via waitUntil at the call site) so the
 * settings UI can show "last seen 3 minutes ago" for active tokens.
 */
export async function resolveTokenOwner(
	db: D1Database,
	plaintext: string
): Promise<{ tokenId: string; userId: string } | null> {
	if (!plaintext || !plaintext.startsWith(TOKEN_PREFIX)) return null;
	const hash = await hashToken(plaintext);
	const row = await db
		.prepare('SELECT id, user_id FROM mcp_tokens WHERE token_hash = ?')
		.bind(hash)
		.first<{ id: string; user_id: string }>();
	if (!row) return null;
	return { tokenId: row.id, userId: row.user_id };
}

export async function touchLastUsed(db: D1Database, tokenId: string): Promise<void> {
	await db
		.prepare("UPDATE mcp_tokens SET last_used_at = datetime('now') WHERE id = ?")
		.bind(tokenId)
		.run();
}

/** Insert a new token for a user. Returns the id assigned. */
export async function persistToken(
	db: D1Database,
	userId: string,
	hash: string,
	prefix: string,
	label: string | null
): Promise<string> {
	const id = newId();
	await db
		.prepare(
			'INSERT INTO mcp_tokens (id, user_id, token_hash, prefix, label, created_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
		)
		.bind(id, userId, hash, prefix, label)
		.run();
	return id;
}

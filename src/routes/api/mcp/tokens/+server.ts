import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { generateToken, persistToken, type McpScope } from '$lib/server/mcp/auth';
import type { RequestHandler } from './$types';

/**
 * Token management for the user's MCP tokens.
 *  - GET: list this user's tokens (label, prefix, created/last-used timestamps). Never
 *    returns the plaintext — that's only available at creation time.
 *  - POST: create a new token. The plaintext appears in the response exactly once;
 *    the UI must capture it before navigating away.
 *
 * Per-token DELETE lives in `[id]/+server.ts`.
 */

interface TokenRow {
	id: string;
	prefix: string;
	label: string | null;
	last_used_at: string | null;
	created_at: string;
	scopes: string;
	expires_at: string | null;
}

const NO_STORE = { 'Cache-Control': 'no-store' };

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');
	const db = getDb(platform!);
	const res = await db
		.prepare(
			`SELECT id, prefix, label, last_used_at, created_at, scopes, expires_at
			 FROM mcp_tokens WHERE user_id = ? AND kind = 'static' ORDER BY created_at DESC`
		)
		.bind(locals.userId)
		.all<TokenRow>();
	return json({ tokens: res.results }, { headers: NO_STORE });
};

const MAX_TOKENS_PER_USER = 10;
const MAX_LABEL_CHARS = 80;

export const POST: RequestHandler = async ({ platform, request, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');
	const db = getDb(platform!);

	// Cap tokens per user. Anyone needing more than ten distinct MCP integrations should
	// be revoking the unused ones first, not stacking forever.
	const countRow = await db
		.prepare("SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_id = ? AND kind = 'static'")
		.bind(locals.userId)
		.first<{ n: number }>();
	if ((countRow?.n ?? 0) >= MAX_TOKENS_PER_USER) {
		return json({ error: 'too_many_tokens' }, { status: 400 });
	}

	const body = (await request.json().catch(() => ({}))) as {
		label?: unknown;
		profile?: unknown;
		expires_in_days?: unknown;
	};
	const labelRaw = typeof body.label === 'string' ? body.label.trim() : '';
	const label = labelRaw ? labelRaw.slice(0, MAX_LABEL_CHARS) : null;

	const profile = body.profile === 'author' ? 'author' : 'study';
	const scopes: McpScope[] = profile === 'author'
		? ['cards:read', 'study:read', 'cards:write']
		: ['cards:read', 'study:read'];
	const rawDays = Number(body.expires_in_days ?? 365);
	const days = Math.max(1, Math.min(365, Number.isFinite(rawDays) ? Math.floor(rawDays) : 365));
	const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

	const { plaintext, hash, prefix } = await generateToken();
	const id = await persistToken(db, locals.userId, hash, prefix, label, scopes, expiresAt);

	return json(
		{ id, plaintext, prefix, label, profile, scopes, expires_at: expiresAt },
		{ headers: NO_STORE }
	);
};

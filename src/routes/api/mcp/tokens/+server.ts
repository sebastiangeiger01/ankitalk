import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { generateToken, persistToken } from '$lib/server/mcp/auth';
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
}

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');
	const db = getDb(platform!);
	const res = await db
		.prepare('SELECT id, prefix, label, last_used_at, created_at FROM mcp_tokens WHERE user_id = ? ORDER BY created_at DESC')
		.bind(locals.userId)
		.all<TokenRow>();
	return json({ tokens: res.results });
};

const MAX_TOKENS_PER_USER = 10;
const MAX_LABEL_CHARS = 80;

export const POST: RequestHandler = async ({ platform, request, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');
	const db = getDb(platform!);

	// Cap tokens per user. Anyone needing more than ten distinct MCP integrations should
	// be revoking the unused ones first, not stacking forever.
	const countRow = await db
		.prepare('SELECT COUNT(*) AS n FROM mcp_tokens WHERE user_id = ?')
		.bind(locals.userId)
		.first<{ n: number }>();
	if ((countRow?.n ?? 0) >= MAX_TOKENS_PER_USER) {
		return json({ error: 'too_many_tokens' }, { status: 400 });
	}

	const body = (await request.json().catch(() => ({}))) as { label?: unknown };
	const labelRaw = typeof body.label === 'string' ? body.label.trim() : '';
	const label = labelRaw ? labelRaw.slice(0, MAX_LABEL_CHARS) : null;

	const { plaintext, hash, prefix } = await generateToken();
	const id = await persistToken(db, locals.userId, hash, prefix, label);

	return json({ id, plaintext, prefix, label });
};

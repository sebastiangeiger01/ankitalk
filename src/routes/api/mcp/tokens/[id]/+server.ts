import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

/** Revoke a single MCP token. The owning user is required to match. */
export const DELETE: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');
	const db = getDb(platform!);
	const tokenId = params.id;
	if (!tokenId) throw error(400, 'Invalid token id');
	const res = await db
		.prepare('DELETE FROM mcp_tokens WHERE id = ? AND user_id = ?')
		.bind(tokenId, locals.userId)
		.run();
	if (!res.meta.changes) {
		return json({ error: 'not_found' }, { status: 404 });
	}
	return json({ ok: true });
};

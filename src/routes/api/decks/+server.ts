import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);

	const decks = await db
		.prepare(
			`SELECT d.*,
				(SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id AND c.due_at <= datetime('now')) as due_count
			FROM decks d
			WHERE d.user_id = ?
			ORDER BY d.created_at DESC`
		)
		.bind(locals.userId)
		.all();

	return json({ decks: decks.results });
};

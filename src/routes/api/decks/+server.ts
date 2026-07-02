import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);

	const decks = await db
		.prepare(
			`SELECT d.*,
				(SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id AND c.due_at <= datetime('now') AND (c.buried_until IS NULL OR c.buried_until <= datetime('now')) AND c.suspended = 0) as due_count
			FROM decks d
			WHERE d.user_id = ?
			ORDER BY d.created_at DESC`
		)
		.bind(locals.userId)
		.all();

	// The onboarding checklist needs to know whether the user has ever reviewed a card.
	const reviewed = await db
		.prepare(`SELECT EXISTS(SELECT 1 FROM reviews WHERE user_id = ?) as has_reviewed`)
		.bind(locals.userId)
		.first<{ has_reviewed: number }>();

	return json({ decks: decks.results, has_reviewed: Boolean(reviewed?.has_reviewed) });
};

import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const deck = await db
		.prepare(
			`SELECT d.*,
				(SELECT COUNT(*) FROM cards c WHERE c.deck_id = d.id AND c.due_at <= datetime('now') AND (c.buried_until IS NULL OR c.buried_until <= datetime('now')) AND c.suspended = 0) as due_count
			FROM decks d
			WHERE d.id = ? AND d.user_id = ?`
		)
		.bind(params.id, locals.userId)
		.first();

	if (!deck) throw error(404, 'Deck not found');

	return json({ deck });
};

/** Reset all card progress in a deck (back to New state, delete reviews). */
export const POST: RequestHandler = async ({ params, request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const body = (await request.json()) as { action?: string };
	if (body.action !== 'reset') throw error(400, 'Invalid action');

	const db = getDb(platform!);

	const deck = await db
		.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first();

	if (!deck) throw error(404, 'Deck not found');

	await db.batch([
		db.prepare('DELETE FROM reviews WHERE deck_id = ? AND user_id = ?').bind(params.id, locals.userId),
		db.prepare(
			`UPDATE cards SET
				due_at = datetime('now'),
				fsrs_state = 0,
				fsrs_stability = 0,
				fsrs_difficulty = 0,
				fsrs_elapsed_days = 0,
				fsrs_scheduled_days = 0,
				fsrs_reps = 0,
				fsrs_lapses = 0,
				fsrs_last_review = NULL,
				learning_step_index = 0,
				buried_until = NULL,
				suspended = 0,
				updated_at = datetime('now')
			WHERE deck_id = ? AND user_id = ?`
		).bind(params.id, locals.userId)
	]);

	return json({ reset: true });
};

export const DELETE: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);

	// Verify ownership
	const deck = await db
		.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first();

	if (!deck) throw error(404, 'Deck not found');

	// Cascade delete (reviews → cards → notes → deck)
	await db.batch([
		db.prepare('DELETE FROM reviews WHERE deck_id = ?').bind(params.id),
		db.prepare('DELETE FROM cards WHERE deck_id = ?').bind(params.id),
		db.prepare('DELETE FROM notes WHERE deck_id = ?').bind(params.id),
		db.prepare('DELETE FROM decks WHERE id = ?').bind(params.id)
	]);

	return json({ deleted: true });
};

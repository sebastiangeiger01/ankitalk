import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);

	const deck = await db
		.prepare('SELECT * FROM decks WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first();

	if (!deck) throw error(404, 'Deck not found');

	const [notes, cards] = await Promise.all([
		db.prepare('SELECT * FROM notes WHERE deck_id = ? AND user_id = ?').bind(params.id, locals.userId).all(),
		db.prepare('SELECT * FROM cards WHERE deck_id = ? AND user_id = ?').bind(params.id, locals.userId).all()
	]);

	return json({
		deck,
		notes: notes.results,
		cards: cards.results
	});
};

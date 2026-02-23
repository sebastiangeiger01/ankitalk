import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const deckId = url.searchParams.get('deckId');
	if (!deckId) throw error(400, 'Missing deckId');

	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20') || 20, 100);

	const db = getDb(platform!);

	// Verify deck ownership
	const deck = await db
		.prepare('SELECT id, name FROM decks WHERE id = ? AND user_id = ?')
		.bind(deckId, locals.userId)
		.first<{ id: string; name: string }>();

	if (!deck) throw error(404, 'Deck not found');

	const cards = await db
		.prepare(
			`SELECT c.*, n.model_name, n.fields, n.tags
			FROM cards c
			JOIN notes n ON n.id = c.note_id
			WHERE c.deck_id = ? AND c.due_at <= datetime('now')
			ORDER BY c.due_at ASC
			LIMIT ?`
		)
		.bind(deckId, limit)
		.all();

	return json({ cards: cards.results, deckName: deck.name });
};

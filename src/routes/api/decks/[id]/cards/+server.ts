import { json, error } from '@sveltejs/kit';
import { getDb, newId } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);

	// Verify deck ownership
	const deck = await db
		.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first();
	if (!deck) throw error(404, 'Deck not found');

	const q = url.searchParams.get('q') ?? '';
	const state = url.searchParams.get('state') ?? 'all';
	const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1') || 1);
	const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '20') || 20));
	const offset = (page - 1) * pageSize;

	// Build WHERE clauses
	const conditions: string[] = ['c.deck_id = ?', 'c.user_id = ?'];
	const binds: (string | number)[] = [params.id, locals.userId];

	// State filter
	if (state === 'new') {
		conditions.push('c.fsrs_state = 0 AND c.suspended = 0');
	} else if (state === 'learning') {
		conditions.push('c.fsrs_state IN (1, 3) AND c.suspended = 0');
	} else if (state === 'review') {
		conditions.push('c.fsrs_state = 2 AND c.suspended = 0');
	} else if (state === 'suspended') {
		conditions.push('c.suspended = 1');
	}
	// 'all' — no extra filter

	// Search filter
	if (q) {
		conditions.push("n.fields LIKE ?");
		binds.push(`%${q}%`);
	}

	const where = conditions.join(' AND ');

	// Parallel: fetch cards + count
	const [cards, countRow] = await Promise.all([
		db
			.prepare(
				`SELECT c.id, c.note_id, c.card_type, c.due_at, c.fsrs_state, c.fsrs_reps, c.fsrs_lapses, c.suspended, n.fields, n.tags
				FROM cards c
				JOIN notes n ON n.id = c.note_id
				WHERE ${where}
				ORDER BY c.due_at ASC
				LIMIT ? OFFSET ?`
			)
			.bind(...binds, pageSize, offset)
			.all(),
		db
			.prepare(
				`SELECT COUNT(*) as total
				FROM cards c
				JOIN notes n ON n.id = c.note_id
				WHERE ${where}`
			)
			.bind(...binds)
			.first<{ total: number }>()
	]);

	return json({
		cards: cards.results,
		total: countRow?.total ?? 0,
		page,
		pageSize
	});
};

export const POST: RequestHandler = async ({ params, request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const body = (await request.json()) as {
		fields: { name: string; value: string }[];
		tags?: string;
		cardType?: 'basic' | 'cloze';
		modelName?: string;
	};

	if (!body.fields || body.fields.length === 0) {
		throw error(400, 'Fields are required');
	}

	const db = getDb(platform!);

	// Verify deck ownership
	const deck = await db
		.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first();
	if (!deck) throw error(404, 'Deck not found');

	const noteId = newId();
	const cardId = newId();
	const now = new Date().toISOString();

	await db.batch([
		db
			.prepare(
				'INSERT INTO notes (id, user_id, deck_id, anki_id, model_name, fields, tags, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)'
			)
			.bind(
				noteId,
				locals.userId,
				params.id,
				body.modelName ?? 'Basic',
				JSON.stringify(body.fields),
				body.tags ?? '',
				now
			),
		db
			.prepare(
				`INSERT INTO cards (id, user_id, deck_id, note_id, anki_id, ordinal, card_type, due_at,
					fsrs_state, fsrs_stability, fsrs_difficulty, fsrs_elapsed_days, fsrs_scheduled_days,
					fsrs_reps, fsrs_lapses, fsrs_last_review, buried_until, suspended, created_at, updated_at)
				VALUES (?, ?, ?, ?, NULL, 0, ?, ?, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, 0, ?, ?)`
			)
			.bind(cardId, locals.userId, params.id, noteId, body.cardType ?? 'basic', now, now, now),
		db
			.prepare("UPDATE decks SET card_count = card_count + 1, updated_at = datetime('now') WHERE id = ?")
			.bind(params.id)
	]);

	return json({ cardId, noteId }, { status: 201 });
};

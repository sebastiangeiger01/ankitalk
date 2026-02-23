import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

/** Day boundary: 4 AM UTC (matches Anki's default rollover) */
function todayStart(): string {
	const now = new Date();
	const d = new Date(now);
	d.setUTCHours(4, 0, 0, 0);
	if (now < d) {
		// Before 4 AM UTC — "today" started yesterday at 4 AM
		d.setUTCDate(d.getUTCDate() - 1);
	}
	return d.toISOString();
}

export const GET: RequestHandler = async ({ url, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const deckId = url.searchParams.get('deckId');
	if (!deckId) throw error(400, 'Missing deckId');

	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50') || 50, 200);
	const mode = url.searchParams.get('mode'); // 'cram' or null
	const tagsParam = url.searchParams.get('tags'); // comma-separated tags
	const cramState = url.searchParams.get('cramState'); // optional state filter for cram

	const db = getDb(platform!);

	// Verify deck ownership
	const deck = await db
		.prepare('SELECT id, name FROM decks WHERE id = ? AND user_id = ?')
		.bind(deckId, locals.userId)
		.first<{ id: string; name: string }>();

	if (!deck) throw error(404, 'Deck not found');

	// Build tag filter clause + binds
	let tagClause = '';
	const tagBinds: string[] = [];
	if (tagsParam) {
		const tags = tagsParam.split(',').map((t) => t.trim()).filter(Boolean);
		if (tags.length > 0) {
			const tagConditions = tags.map(() => "(' ' || n.tags || ' ') LIKE ?");
			tagClause = ' AND (' + tagConditions.join(' OR ') + ')';
			for (const tag of tags) {
				tagBinds.push(`% ${tag} %`);
			}
		}
	}

	const now = new Date().toISOString();

	// Cram mode: skip daily limits, ignore due_at filter, different ordering
	if (mode === 'cram') {
		let stateClause = '';
		const stateBinds: number[] = [];
		if (cramState === 'new') {
			stateClause = ' AND c.fsrs_state = 0';
		} else if (cramState === 'learning') {
			stateClause = ' AND c.fsrs_state IN (1, 3)';
		} else if (cramState === 'review') {
			stateClause = ' AND c.fsrs_state = 2';
		}

		const cards = await db
			.prepare(
				`SELECT c.*, n.model_name, n.fields, n.tags
				FROM cards c
				JOIN notes n ON n.id = c.note_id
				WHERE c.deck_id = ? AND c.user_id = ?
					AND c.suspended = 0
					AND (c.buried_until IS NULL OR c.buried_until <= ?)
					${stateClause}${tagClause}
				ORDER BY c.fsrs_reps ASC, RANDOM()
				LIMIT ?`
			)
			.bind(deckId, locals.userId, now, ...stateBinds, ...tagBinds, limit)
			.all();

		return json({ cards: cards.results, deckName: deck.name, mode: 'cram' });
	}

	// Normal mode
	// Load deck settings (or use defaults)
	const settings = await db
		.prepare('SELECT new_cards_per_day, max_reviews_per_day FROM deck_settings WHERE deck_id = ?')
		.bind(deckId)
		.first<{ new_cards_per_day: number; max_reviews_per_day: number }>();

	const newPerDay = settings?.new_cards_per_day ?? 20;
	const maxReviews = settings?.max_reviews_per_day ?? 200;

	// Count today's completions (since 4 AM UTC)
	const dayStart = todayStart();

	const counts = await db
		.prepare(
			`SELECT
				SUM(CASE WHEN c.fsrs_state = 0 THEN 1 ELSE 0 END) as new_done,
				SUM(CASE WHEN c.fsrs_state = 2 THEN 1 ELSE 0 END) as review_done
			FROM reviews r
			JOIN cards c ON c.id = r.card_id
			WHERE r.deck_id = ? AND r.user_id = ? AND r.created_at >= ?`
		)
		.bind(deckId, locals.userId, dayStart)
		.first<{ new_done: number | null; review_done: number | null }>();

	const newDone = counts?.new_done ?? 0;
	const reviewDone = counts?.review_done ?? 0;

	const newRemaining = Math.max(0, newPerDay - newDone);
	const reviewRemaining = Math.max(0, maxReviews - reviewDone);

	// Fetch cards in priority order:
	// 1. Learning/Relearning (state 1,3) — no limit, due now
	// 2. Review (state 2) — limited
	// 3. New (state 0) — limited
	// Exclude buried cards
	const cards = await db
		.prepare(
			`SELECT * FROM (
				-- Learning / Relearning: no daily limit
				SELECT c.*, n.model_name, n.fields, n.tags, 0 as sort_priority
				FROM cards c
				JOIN notes n ON n.id = c.note_id
				WHERE c.deck_id = ? AND c.user_id = ?
					AND c.fsrs_state IN (1, 3)
					AND c.due_at <= ?
					AND (c.buried_until IS NULL OR c.buried_until <= ?)
					AND c.suspended = 0
					${tagClause}

				UNION ALL

				-- Review: daily limit
				SELECT c.*, n.model_name, n.fields, n.tags, 1 as sort_priority
				FROM cards c
				JOIN notes n ON n.id = c.note_id
				WHERE c.deck_id = ? AND c.user_id = ?
					AND c.fsrs_state = 2
					AND c.due_at <= ?
					AND (c.buried_until IS NULL OR c.buried_until <= ?)
					AND c.suspended = 0
					${tagClause}
				ORDER BY c.due_at ASC
				LIMIT ?

				UNION ALL

				-- New: daily limit
				SELECT c.*, n.model_name, n.fields, n.tags, 2 as sort_priority
				FROM cards c
				JOIN notes n ON n.id = c.note_id
				WHERE c.deck_id = ? AND c.user_id = ?
					AND c.fsrs_state = 0
					AND c.due_at <= ?
					AND (c.buried_until IS NULL OR c.buried_until <= ?)
					AND c.suspended = 0
					${tagClause}
				ORDER BY c.due_at ASC
				LIMIT ?
			)
			ORDER BY sort_priority ASC, due_at ASC
			LIMIT ?`
		)
		.bind(
			// Learning
			deckId, locals.userId, now, now, ...tagBinds,
			// Review
			deckId, locals.userId, now, now, ...tagBinds, reviewRemaining,
			// New
			deckId, locals.userId, now, now, ...tagBinds, newRemaining,
			// Overall
			limit
		)
		.all();

	return json({ cards: cards.results, deckName: deck.name, mode: 'normal' });
};

import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const days = Math.min(Math.max(1, parseInt(url.searchParams.get('days') ?? '30') || 30), 365);

	const db = getDb(platform!);

	// Verify deck ownership
	const deck = await db
		.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first();

	if (!deck) throw error(404, 'Deck not found');

	// 1. Card state breakdown
	const stateBreakdown = await db
		.prepare(
			`SELECT
				SUM(CASE WHEN fsrs_state = 0 AND suspended = 0 THEN 1 ELSE 0 END) as new_count,
				SUM(CASE WHEN fsrs_state = 1 AND suspended = 0 THEN 1 ELSE 0 END) as learning_count,
				SUM(CASE WHEN fsrs_state = 2 AND suspended = 0 THEN 1 ELSE 0 END) as review_count,
				SUM(CASE WHEN fsrs_state = 3 AND suspended = 0 THEN 1 ELSE 0 END) as relearning_count,
				SUM(CASE WHEN suspended = 1 THEN 1 ELSE 0 END) as suspended_count
			FROM cards
			WHERE deck_id = ? AND user_id = ?`
		)
		.bind(params.id, locals.userId)
		.first<{
			new_count: number | null;
			learning_count: number | null;
			review_count: number | null;
			relearning_count: number | null;
			suspended_count: number | null;
		}>();

	// 2. Daily review history
	const dailyReviews = await db
		.prepare(
			`SELECT
				date(r.created_at) as day,
				SUM(CASE WHEN r.rating = 'again' THEN 1 ELSE 0 END) as again_count,
				SUM(CASE WHEN r.rating = 'hard' THEN 1 ELSE 0 END) as hard_count,
				SUM(CASE WHEN r.rating = 'good' THEN 1 ELSE 0 END) as good_count,
				SUM(CASE WHEN r.rating = 'easy' THEN 1 ELSE 0 END) as easy_count,
				COUNT(*) as total,
				AVG(r.duration_ms) as avg_duration_ms
			FROM reviews r
			WHERE r.deck_id = ? AND r.user_id = ?
				AND r.created_at >= date('now', '-' || ? || ' days')
			GROUP BY date(r.created_at)
			ORDER BY day ASC`
		)
		.bind(params.id, locals.userId, days)
		.all();

	// 3. Retention rate (mature cards = fsrs_state 2 reviews not rated "again")
	const retention = await db
		.prepare(
			`SELECT
				COUNT(*) as total_mature_reviews,
				SUM(CASE WHEN r.rating != 'again' THEN 1 ELSE 0 END) as passed
			FROM reviews r
			JOIN cards c ON c.id = r.card_id
			WHERE r.deck_id = ? AND r.user_id = ?
				AND c.fsrs_state = 2
				AND r.created_at >= date('now', '-' || ? || ' days')`
		)
		.bind(params.id, locals.userId, days)
		.first<{ total_mature_reviews: number | null; passed: number | null }>();

	const totalMature = retention?.total_mature_reviews ?? 0;
	const retentionRate = totalMature > 0 ? (retention?.passed ?? 0) / totalMature : null;

	return json({
		cardStates: {
			new: stateBreakdown?.new_count ?? 0,
			learning: stateBreakdown?.learning_count ?? 0,
			review: stateBreakdown?.review_count ?? 0,
			relearning: stateBreakdown?.relearning_count ?? 0,
			suspended: stateBreakdown?.suspended_count ?? 0
		},
		dailyReviews: dailyReviews.results,
		retentionRate,
		days
	});
};

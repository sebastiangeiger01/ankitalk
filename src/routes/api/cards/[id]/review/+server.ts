import { json, error } from '@sveltejs/kit';
import { getDb, newId } from '$lib/server/db';
import { scheduleCard } from '$lib/fsrs';
import type { Card, RatingName } from '$lib/types';
import type { RequestHandler } from './$types';

const VALID_RATINGS: RatingName[] = ['again', 'hard', 'good', 'easy'];

export const POST: RequestHandler = async ({ params, request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const body = (await request.json()) as { rating: string; durationMs?: number };
	const { rating, durationMs } = body;

	if (!VALID_RATINGS.includes(rating as RatingName)) {
		throw error(400, 'Invalid rating');
	}

	const db = getDb(platform!);

	// Fetch the card
	const card = (await db
		.prepare('SELECT * FROM cards WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first()) as Card | null;

	if (!card) throw error(404, 'Card not found');

	// Calculate FSRS scheduling
	const result = scheduleCard(card, rating as RatingName);

	// Batch: insert review + update card
	const reviewId = newId();
	await db.batch([
		db
			.prepare(
				'INSERT INTO reviews (id, user_id, card_id, deck_id, rating, duration_ms) VALUES (?, ?, ?, ?, ?, ?)'
			)
			.bind(reviewId, locals.userId, card.id, card.deck_id, rating, durationMs ?? null),
		db
			.prepare(
				`UPDATE cards SET
					due_at = ?,
					fsrs_state = ?,
					fsrs_stability = ?,
					fsrs_difficulty = ?,
					fsrs_elapsed_days = ?,
					fsrs_scheduled_days = ?,
					fsrs_reps = ?,
					fsrs_lapses = ?,
					fsrs_last_review = ?,
					updated_at = datetime('now')
				WHERE id = ?`
			)
			.bind(
				result.dueAt,
				result.fsrsState,
				result.fsrsStability,
				result.fsrsDifficulty,
				result.fsrsElapsedDays,
				result.fsrsScheduledDays,
				result.fsrsReps,
				result.fsrsLapses,
				result.fsrsLastReview,
				card.id
			)
	]);

	return json({ reviewId, dueAt: result.dueAt });
};

import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);

	// Find the most recent review for this card that has snapshot data
	const review = await db
		.prepare(
			`SELECT id, prev_due_at, prev_fsrs_state, prev_fsrs_stability, prev_fsrs_difficulty,
				prev_fsrs_elapsed_days, prev_fsrs_scheduled_days, prev_fsrs_reps, prev_fsrs_lapses,
				prev_fsrs_last_review
			FROM reviews
			WHERE card_id = ? AND user_id = ? AND prev_fsrs_state IS NOT NULL
			ORDER BY created_at DESC
			LIMIT 1`
		)
		.bind(params.id, locals.userId)
		.first<{
			id: string;
			prev_due_at: string;
			prev_fsrs_state: number;
			prev_fsrs_stability: number;
			prev_fsrs_difficulty: number;
			prev_fsrs_elapsed_days: number;
			prev_fsrs_scheduled_days: number;
			prev_fsrs_reps: number;
			prev_fsrs_lapses: number;
			prev_fsrs_last_review: string | null;
		}>();

	if (!review) throw error(404, 'No undoable review found');

	// Batch: delete review + restore card state + unsuspend
	await db.batch([
		db.prepare('DELETE FROM reviews WHERE id = ?').bind(review.id),
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
					suspended = 0,
					updated_at = datetime('now')
				WHERE id = ? AND user_id = ?`
			)
			.bind(
				review.prev_due_at,
				review.prev_fsrs_state,
				review.prev_fsrs_stability,
				review.prev_fsrs_difficulty,
				review.prev_fsrs_elapsed_days,
				review.prev_fsrs_scheduled_days,
				review.prev_fsrs_reps,
				review.prev_fsrs_lapses,
				review.prev_fsrs_last_review,
				params.id,
				locals.userId
			)
	]);

	return json({ undone: true });
};

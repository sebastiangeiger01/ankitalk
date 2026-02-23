import { json, error } from '@sveltejs/kit';
import { getDb, newId } from '$lib/server/db';
import { scheduleCard, parseSteps } from '$lib/fsrs';
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

	// Load deck settings for per-deck FSRS params + learning steps
	const settings = await db
		.prepare('SELECT desired_retention, max_interval, leech_threshold, learning_steps, relearning_steps FROM deck_settings WHERE deck_id = ?')
		.bind(card.deck_id)
		.first<{ desired_retention: number; max_interval: number; leech_threshold: number; learning_steps: string; relearning_steps: string }>();

	const desiredRetention = settings?.desired_retention ?? 0.9;
	const maxInterval = settings?.max_interval ?? 36500;
	const leechThreshold = settings?.leech_threshold ?? 8;
	const learningSteps = parseSteps(settings?.learning_steps ?? '1,10');
	const relearningSteps = parseSteps(settings?.relearning_steps ?? '10');

	// Calculate scheduling with traditional learning steps
	const result = scheduleCard(card, rating as RatingName, new Date(), {
		requestRetention: desiredRetention,
		maximumInterval: maxInterval
	}, {
		learningSteps,
		relearningSteps
	});

	// Detect leech: card rated "again" and lapses reach threshold
	const leeched = rating === 'again' && result.fsrsLapses >= leechThreshold;

	// Batch: insert review (with FSRS snapshot for undo) + update card + bury siblings + optionally suspend leech
	const reviewId = newId();
	const statements = [
		db
			.prepare(
				`INSERT INTO reviews (id, user_id, card_id, deck_id, rating, duration_ms,
					prev_due_at, prev_fsrs_state, prev_fsrs_stability, prev_fsrs_difficulty,
					prev_fsrs_elapsed_days, prev_fsrs_scheduled_days, prev_fsrs_reps, prev_fsrs_lapses, prev_fsrs_last_review,
					prev_learning_step_index)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				reviewId, locals.userId, card.id, card.deck_id, rating, durationMs ?? null,
				card.due_at, card.fsrs_state, card.fsrs_stability, card.fsrs_difficulty,
				card.fsrs_elapsed_days, card.fsrs_scheduled_days, card.fsrs_reps, card.fsrs_lapses,
				card.fsrs_last_review,
				card.learning_step_index ?? 0
			),
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
					learning_step_index = ?,
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
				result.learningStepIndex,
				card.id
			),
		// Bury siblings (other cards from same note in same deck)
		db
			.prepare(
				`UPDATE cards SET buried_until = date('now', '+1 day')
				WHERE note_id = ? AND id != ? AND deck_id = ?`
			)
			.bind(card.note_id, card.id, card.deck_id)
	];

	// Suspend leeched card
	if (leeched) {
		statements.push(
			db
				.prepare("UPDATE cards SET suspended = 1, updated_at = datetime('now') WHERE id = ?")
				.bind(card.id)
		);
	}

	await db.batch(statements);

	return json({ reviewId, dueAt: result.dueAt, fsrsState: result.fsrsState, leeched });
};

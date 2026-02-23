import {
	createEmptyCard,
	fsrs,
	Rating,
	type Card as FSRSCard,
	type Grade,
	type RecordLogItem,
	State
} from 'ts-fsrs';
import type { Card, RatingName } from './types';

export interface FsrsOptions {
	requestRetention?: number;
	maximumInterval?: number;
}

/**
 * Convert a D1 card row to a ts-fsrs Card object.
 */
export function dbCardToFsrs(card: Card): FSRSCard {
	if (card.fsrs_reps === 0) {
		return createEmptyCard(new Date(card.due_at));
	}

	return {
		due: new Date(card.due_at),
		stability: card.fsrs_stability,
		difficulty: card.fsrs_difficulty,
		elapsed_days: card.fsrs_elapsed_days,
		scheduled_days: card.fsrs_scheduled_days,
		reps: card.fsrs_reps,
		lapses: card.fsrs_lapses,
		state: card.fsrs_state as State,
		last_review: card.fsrs_last_review ? new Date(card.fsrs_last_review) : undefined
	};
}

/**
 * Map rating name to ts-fsrs Rating enum.
 */
export function ratingNameToEnum(name: RatingName): Grade {
	switch (name) {
		case 'again':
			return Rating.Again;
		case 'hard':
			return Rating.Hard;
		case 'good':
			return Rating.Good;
		case 'easy':
			return Rating.Easy;
	}
}

export interface ScheduleResult {
	fsrsState: number;
	fsrsStability: number;
	fsrsDifficulty: number;
	fsrsElapsedDays: number;
	fsrsScheduledDays: number;
	fsrsReps: number;
	fsrsLapses: number;
	fsrsLastReview: string;
	dueAt: string;
}

/**
 * Schedule a card after a review rating.
 */
export function scheduleCard(
	card: Card,
	rating: RatingName,
	now: Date = new Date(),
	options?: FsrsOptions
): ScheduleResult {
	const scheduler = fsrs({
		request_retention: options?.requestRetention ?? 0.9,
		maximum_interval: options?.maximumInterval ?? 36500
	});
	const fsrsCard = dbCardToFsrs(card);
	const fsrsRating = ratingNameToEnum(rating);
	const result: RecordLogItem = scheduler.repeat(fsrsCard, now)[fsrsRating];

	const scheduled = result.card;
	return {
		fsrsState: scheduled.state,
		fsrsStability: scheduled.stability,
		fsrsDifficulty: scheduled.difficulty,
		fsrsElapsedDays: scheduled.elapsed_days,
		fsrsScheduledDays: scheduled.scheduled_days,
		fsrsReps: scheduled.reps,
		fsrsLapses: scheduled.lapses,
		fsrsLastReview: now.toISOString(),
		dueAt: scheduled.due.toISOString()
	};
}

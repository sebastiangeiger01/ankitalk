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

export interface LearningStepsOptions {
	learningSteps?: number[];   // minutes, e.g. [1, 10]
	relearningSteps?: number[]; // minutes, e.g. [10]
}

/**
 * Parse a comma-separated steps string like "1,10" into an array of minutes.
 */
export function parseSteps(s: string | null | undefined): number[] {
	if (!s || !s.trim()) return [];
	return s.split(',').map((v) => parseFloat(v.trim())).filter((v) => !isNaN(v) && v > 0);
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
	learningStepIndex: number;
}

/**
 * Add minutes to a date.
 */
function addMinutes(date: Date, minutes: number): Date {
	return new Date(date.getTime() + minutes * 60_000);
}

/**
 * Compute the Hard delay for learning/relearning steps, matching Anki's exact logic:
 * - At step 0 with 2+ steps: average of step[0] and step[1]
 * - At step 0 with only 1 step: step[0] * 1.5 (capped at step[0] + 1440 min = 1 day)
 * - At step N > 0: step[N] (exact current step delay, no multiplier)
 */
export function hardDelayMinutes(steps: number[], stepIndex: number): number {
	if (stepIndex === 0) {
		if (steps.length >= 2) {
			return (steps[0] + steps[1]) / 2;
		}
		// Single step: 1.5x, capped at current + 1 day
		return Math.min(steps[0] * 1.5, steps[0] + 1440);
	}
	// Later steps: repeat exact current step delay
	return steps[stepIndex] ?? steps[0];
}

/**
 * Schedule a card after a review rating, using traditional learning steps
 * like Anki desktop (FSRS only for graduation / review intervals).
 *
 * State machine (matches Anki desktop):
 * - New (0) / Learning (1): walk through learningSteps.
 *     Again → step 0. Hard → Anki-style delay (avg of first two steps at idx 0, or exact step at idx>0).
 *     Good → next step. Easy → graduate. Graduating → FSRS computes the graduation interval.
 * - Review (2): pure FSRS.
 *     Again → enter relearningSteps (state 3), increment lapses.
 * - Relearning (3): walk through relearningSteps (same Hard logic).
 *     Again → step 0. Good → next step. When done → back to Review (2), FSRS interval.
 */
export function scheduleCard(
	card: Card,
	rating: RatingName,
	now: Date = new Date(),
	options?: FsrsOptions,
	stepsOptions?: LearningStepsOptions
): ScheduleResult {
	const learningSteps = stepsOptions?.learningSteps ?? [1, 10];
	const relearningSteps = stepsOptions?.relearningSteps ?? [10];
	const currentStepIndex = card.learning_step_index ?? 0;
	const state = card.fsrs_state as State;

	const scheduler = fsrs({
		request_retention: options?.requestRetention ?? 0.9,
		maximum_interval: options?.maximumInterval ?? 36500
	});

	// For New (0) and Learning (1): use traditional learning steps
	if ((state === State.New || state === State.Learning) && learningSteps.length > 0) {
		return scheduleLearning(card, rating, now, scheduler, learningSteps, currentStepIndex);
	}

	// For Relearning (3): use relearning steps
	if (state === State.Relearning && relearningSteps.length > 0) {
		return scheduleRelearning(card, rating, now, scheduler, relearningSteps, currentStepIndex);
	}

	// Review (2) or empty steps: pure FSRS
	return scheduleFsrs(card, rating, now, scheduler, relearningSteps);
}

/**
 * Handle learning phase (New + Learning states) with traditional steps.
 */
function scheduleLearning(
	card: Card,
	rating: RatingName,
	now: Date,
	scheduler: ReturnType<typeof fsrs>,
	steps: number[],
	stepIndex: number
): ScheduleResult {
	// Always run FSRS to update stability/difficulty even during learning
	const fsrsCard = dbCardToFsrs(card);
	const fsrsRating = ratingNameToEnum(rating);
	const fsrsResult = scheduler.repeat(fsrsCard, now)[fsrsRating];
	const sched = fsrsResult.card;

	const base: Omit<ScheduleResult, 'fsrsState' | 'dueAt' | 'learningStepIndex'> = {
		fsrsStability: sched.stability,
		fsrsDifficulty: sched.difficulty,
		fsrsElapsedDays: sched.elapsed_days,
		fsrsScheduledDays: sched.scheduled_days,
		fsrsReps: sched.reps,
		fsrsLapses: sched.lapses,
		fsrsLastReview: now.toISOString()
	};

	switch (rating) {
		case 'again':
			// Restart at step 0
			return {
				...base,
				fsrsState: State.Learning,
				dueAt: addMinutes(now, steps[0]).toISOString(),
				learningStepIndex: 0
			};

		case 'hard': {
			// Anki's Hard logic: at step 0 avg first two steps, at later steps repeat exact delay
			return {
				...base,
				fsrsState: State.Learning,
				dueAt: addMinutes(now, hardDelayMinutes(steps, stepIndex)).toISOString(),
				learningStepIndex: stepIndex
			};
		}

		case 'good': {
			const nextStep = stepIndex + 1;
			if (nextStep >= steps.length) {
				// Graduate! FSRS determines the graduation interval
				return {
					...base,
					fsrsState: State.Review,
					fsrsScheduledDays: sched.scheduled_days,
					dueAt: sched.due.toISOString(),
					learningStepIndex: 0
				};
			}
			// Advance to next step
			return {
				...base,
				fsrsState: State.Learning,
				dueAt: addMinutes(now, steps[nextStep]).toISOString(),
				learningStepIndex: nextStep
			};
		}

		case 'easy':
			// Graduate immediately with Easy bonus (FSRS Easy interval)
			return {
				...base,
				fsrsState: State.Review,
				fsrsScheduledDays: sched.scheduled_days,
				dueAt: sched.due.toISOString(),
				learningStepIndex: 0
			};
	}
}

/**
 * Handle relearning phase with traditional steps.
 */
function scheduleRelearning(
	card: Card,
	rating: RatingName,
	now: Date,
	scheduler: ReturnType<typeof fsrs>,
	steps: number[],
	stepIndex: number
): ScheduleResult {
	const fsrsCard = dbCardToFsrs(card);
	const fsrsRating = ratingNameToEnum(rating);
	const fsrsResult = scheduler.repeat(fsrsCard, now)[fsrsRating];
	const sched = fsrsResult.card;

	const base: Omit<ScheduleResult, 'fsrsState' | 'dueAt' | 'learningStepIndex'> = {
		fsrsStability: sched.stability,
		fsrsDifficulty: sched.difficulty,
		fsrsElapsedDays: sched.elapsed_days,
		fsrsScheduledDays: sched.scheduled_days,
		fsrsReps: sched.reps,
		fsrsLapses: sched.lapses,
		fsrsLastReview: now.toISOString()
	};

	switch (rating) {
		case 'again':
			return {
				...base,
				fsrsState: State.Relearning,
				dueAt: addMinutes(now, steps[0]).toISOString(),
				learningStepIndex: 0
			};

		case 'hard': {
			return {
				...base,
				fsrsState: State.Relearning,
				dueAt: addMinutes(now, hardDelayMinutes(steps, stepIndex)).toISOString(),
				learningStepIndex: stepIndex
			};
		}

		case 'good': {
			const nextStep = stepIndex + 1;
			if (nextStep >= steps.length) {
				// Done with relearning → back to Review
				return {
					...base,
					fsrsState: State.Review,
					fsrsScheduledDays: sched.scheduled_days,
					dueAt: sched.due.toISOString(),
					learningStepIndex: 0
				};
			}
			return {
				...base,
				fsrsState: State.Relearning,
				dueAt: addMinutes(now, steps[nextStep]).toISOString(),
				learningStepIndex: nextStep
			};
		}

		case 'easy':
			// Skip remaining relearning, back to Review with FSRS interval
			return {
				...base,
				fsrsState: State.Review,
				fsrsScheduledDays: sched.scheduled_days,
				dueAt: sched.due.toISOString(),
				learningStepIndex: 0
			};
	}
}

/**
 * Pure FSRS scheduling for Review state.
 */
function scheduleFsrs(
	card: Card,
	rating: RatingName,
	now: Date,
	scheduler: ReturnType<typeof fsrs>,
	relearningSteps: number[]
): ScheduleResult {
	const fsrsCard = dbCardToFsrs(card);
	const fsrsRating = ratingNameToEnum(rating);
	const result: RecordLogItem = scheduler.repeat(fsrsCard, now)[fsrsRating];
	const scheduled = result.card;

	// If Again on a Review card, enter relearning with first step
	if (rating === 'again' && relearningSteps.length > 0) {
		return {
			fsrsState: State.Relearning,
			fsrsStability: scheduled.stability,
			fsrsDifficulty: scheduled.difficulty,
			fsrsElapsedDays: scheduled.elapsed_days,
			fsrsScheduledDays: scheduled.scheduled_days,
			fsrsReps: scheduled.reps,
			fsrsLapses: scheduled.lapses,
			fsrsLastReview: now.toISOString(),
			dueAt: addMinutes(now, relearningSteps[0]).toISOString(),
			learningStepIndex: 0
		};
	}

	return {
		fsrsState: scheduled.state,
		fsrsStability: scheduled.stability,
		fsrsDifficulty: scheduled.difficulty,
		fsrsElapsedDays: scheduled.elapsed_days,
		fsrsScheduledDays: scheduled.scheduled_days,
		fsrsReps: scheduled.reps,
		fsrsLapses: scheduled.lapses,
		fsrsLastReview: now.toISOString(),
		dueAt: scheduled.due.toISOString(),
		learningStepIndex: 0
	};
}

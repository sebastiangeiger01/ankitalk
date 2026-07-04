import { describe, expect, it } from 'vitest';
import { parseSteps, scheduleCard, validateSteps } from './fsrs';
import type { Card } from './types';

describe('validateSteps', () => {
	it('accepts a single positive number', () => {
		expect(validateSteps('10')).toEqual({ valid: true, steps: [10] });
	});

	it('accepts comma-separated numbers with surrounding spaces', () => {
		expect(validateSteps(' 1, 10 ')).toEqual({ valid: true, steps: [1, 10] });
		expect(validateSteps('1,10,60')).toEqual({ valid: true, steps: [1, 10, 60] });
	});

	it('accepts decimal steps', () => {
		expect(validateSteps('0.5, 10')).toEqual({ valid: true, steps: [0.5, 10] });
		expect(validateSteps('.5')).toEqual({ valid: true, steps: [0.5] });
	});

	it('rejects empty and whitespace-only input', () => {
		expect(validateSteps('')).toEqual({ valid: false, steps: [] });
		expect(validateSteps('   ')).toEqual({ valid: false, steps: [] });
	});

	it('rejects non-numeric entries', () => {
		expect(validateSteps('abc').valid).toBe(false);
		expect(validateSteps('1, abc').valid).toBe(false);
		expect(validateSteps('1min, 10').valid).toBe(false);
	});

	it('rejects zero and negative steps', () => {
		expect(validateSteps('0').valid).toBe(false);
		expect(validateSteps('1, 0, 10').valid).toBe(false);
		expect(validateSteps('-1').valid).toBe(false);
	});

	it('rejects dangling or doubled commas (unlike lenient parseSteps)', () => {
		expect(validateSteps('1,').valid).toBe(false);
		expect(validateSteps(',10').valid).toBe(false);
		expect(validateSteps('1,,10').valid).toBe(false);
	});

	it('rejects space-separated lists and exponent notation', () => {
		expect(validateSteps('1 10').valid).toBe(false);
		expect(validateSteps('1e3').valid).toBe(false);
	});
});

describe('parseSteps', () => {
	it('parses valid lists', () => {
		expect(parseSteps('1,10')).toEqual([1, 10]);
		expect(parseSteps(' 1 , 10 ')).toEqual([1, 10]);
	});

	it('drops junk entries instead of failing', () => {
		expect(parseSteps('1,abc,10')).toEqual([1, 10]);
		expect(parseSteps('0,-5,10')).toEqual([10]);
	});

	it('returns empty for null/undefined/blank', () => {
		expect(parseSteps(null)).toEqual([]);
		expect(parseSteps(undefined)).toEqual([]);
		expect(parseSteps('  ')).toEqual([]);
	});
});

describe('scheduleCard graduation', () => {
	const now = new Date('2026-07-04T12:00:00Z');

	function newCard(overrides: Partial<Card> = {}): Card {
		return {
			id: 'c1',
			user_id: 'u1',
			deck_id: 'd1',
			note_id: 'n1',
			anki_id: null,
			ordinal: 0,
			card_type: 'basic',
			front_template: null,
			back_template: null,
			due_at: now.toISOString(),
			fsrs_state: 0,
			fsrs_stability: 0,
			fsrs_difficulty: 0,
			fsrs_elapsed_days: 0,
			fsrs_scheduled_days: 0,
			fsrs_reps: 0,
			fsrs_lapses: 0,
			fsrs_last_review: null,
			learning_step_index: 0,
			buried_until: null,
			suspended: 0,
			created_at: now.toISOString(),
			updated_at: now.toISOString(),
			...overrides
		};
	}

	const dayMs = 24 * 60 * 60 * 1000;

	it('graduating a New card via Good with a single learning step yields a day-scale review interval', () => {
		// ts-fsrs's short-term scheduler keeps New+Good in Learning (+10m); graduation must not
		// inherit that 10-minute due date.
		const result = scheduleCard(newCard(), 'good', now, undefined, {
			learningSteps: [10],
			relearningSteps: [10]
		});
		expect(result.fsrsState).toBe(2); // Review
		expect(new Date(result.dueAt).getTime() - now.getTime()).toBeGreaterThanOrEqual(dayMs);
	});

	it('graduating from the last Learning step via Good yields a day-scale review interval', () => {
		const card = newCard({ fsrs_state: 1, fsrs_reps: 1, fsrs_stability: 3, fsrs_difficulty: 5, learning_step_index: 1, fsrs_last_review: now.toISOString() });
		const result = scheduleCard(card, 'good', now, undefined, {
			learningSteps: [1, 10],
			relearningSteps: [10]
		});
		expect(result.fsrsState).toBe(2);
		expect(new Date(result.dueAt).getTime() - now.getTime()).toBeGreaterThanOrEqual(dayMs);
	});

	it('Easy on a New card graduates with a day-scale interval', () => {
		const result = scheduleCard(newCard(), 'easy', now, undefined, {
			learningSteps: [1, 10],
			relearningSteps: [10]
		});
		expect(result.fsrsState).toBe(2);
		expect(new Date(result.dueAt).getTime() - now.getTime()).toBeGreaterThanOrEqual(dayMs);
	});

	it('Good before the last step advances to the next step, not graduation', () => {
		const result = scheduleCard(newCard(), 'good', now, undefined, {
			learningSteps: [1, 10],
			relearningSteps: [10]
		});
		expect(result.fsrsState).toBe(1); // Learning
		expect(result.learningStepIndex).toBe(1);
		expect(new Date(result.dueAt).getTime() - now.getTime()).toBe(10 * 60 * 1000);
	});
});

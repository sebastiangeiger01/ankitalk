// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getTutorAnswerContext } from './agent';

describe('getTutorAnswerContext', () => {
	it('includes the real answer before reveal, flagged hidden — secrecy lives in the prompt', () => {
		const context = getTutorAnswerContext('secret answer', false, 100);
		expect(context.visibility).toBe('hidden');
		expect(context.answer).toBe('secret answer');
	});

	it('includes a sanitized answer after reveal', () => {
		expect(getTutorAnswerContext('  visible answer  ', true, 100)).toEqual({
			answer: 'visible answer',
			visibility: 'revealed'
		});
	});

	it('sanitizes and caps the answer in both states', () => {
		const hidden = getTutorAnswerContext('a'.repeat(50), false, 10);
		expect(hidden.answer).toBe('a'.repeat(10));
		expect(hidden.visibility).toBe('hidden');
	});
});

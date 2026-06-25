// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getTutorAnswerContext } from './agent';

describe('getTutorAnswerContext', () => {
	it('does not include the answer before reveal', () => {
		const context = getTutorAnswerContext('secret answer', false, 100);
		expect(context.visibility).toBe('hidden');
		expect(context.answer).not.toContain('secret answer');
	});

	it('includes a sanitized answer after reveal', () => {
		expect(getTutorAnswerContext('  visible answer  ', true, 100)).toEqual({
			answer: 'visible answer',
			visibility: 'revealed'
		});
	});
});

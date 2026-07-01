import { describe, expect, it } from 'vitest';
import { parseSteps, validateSteps } from './fsrs';

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

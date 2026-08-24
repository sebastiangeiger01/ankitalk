import { describe, expect, it } from 'vitest';
import { clampGenerateBatch, DEFAULT_GENERATE_BATCH, MAX_GENERATE_BATCH } from './generate';

describe('clampGenerateBatch', () => {
	it('accepts a sensible client-supplied size', () => {
		expect(clampGenerateBatch(5)).toBe(5);
		expect(clampGenerateBatch(MAX_GENERATE_BATCH)).toBe(MAX_GENERATE_BATCH);
	});

	it('falls back to the default for anything unusable', () => {
		expect(clampGenerateBatch(undefined)).toBe(DEFAULT_GENERATE_BATCH);
		expect(clampGenerateBatch(null)).toBe(DEFAULT_GENERATE_BATCH);
		expect(clampGenerateBatch('lots')).toBe(DEFAULT_GENERATE_BATCH);
		expect(clampGenerateBatch('')).toBe(DEFAULT_GENERATE_BATCH);
		expect(clampGenerateBatch({})).toBe(DEFAULT_GENERATE_BATCH);
		expect(clampGenerateBatch(Number.NaN)).toBe(DEFAULT_GENERATE_BATCH);
	});

	it('never lets a caller ask for the whole document in one request', () => {
		// The bug this whole endpoint exists to fix: one request cannot outlive its invocation,
		// so an unbounded batch would reintroduce the truncated download.
		expect(clampGenerateBatch(10_000)).toBe(MAX_GENERATE_BATCH);
	});

	it('never returns zero or a fraction, which would stall the client loop', () => {
		expect(clampGenerateBatch(0)).toBe(1);
		expect(clampGenerateBatch(-5)).toBe(1);
		expect(clampGenerateBatch(3.9)).toBe(3);
	});
});

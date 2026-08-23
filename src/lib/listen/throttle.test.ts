import { describe, expect, it } from 'vitest';
import { clampPlaybackRate, RUN_AHEAD_LEAD_MS, throttleTargetElapsedMs } from './throttle';

describe('clampPlaybackRate', () => {
	it('passes through the rates the player offers', () => {
		expect(clampPlaybackRate('1')).toBe(1);
		expect(clampPlaybackRate('1.75')).toBe(1.75);
	});

	it('defaults to 1 for a missing or unparseable value', () => {
		expect(clampPlaybackRate(null)).toBe(1);
		expect(clampPlaybackRate('fast')).toBe(1);
	});

	it('clamps out-of-range values', () => {
		expect(clampPlaybackRate('0.1')).toBe(0.5);
		expect(clampPlaybackRate('99')).toBe(3);
	});
});

/** Audio (ms) the generator has run ahead of the playhead after `elapsed` of wall clock. */
function leadAfter(elapsedMs: number, rate: number): number {
	// Invert the throttle: the largest writtenMs whose target elapsed is still <= elapsedMs.
	const written = elapsedMs * rate + RUN_AHEAD_LEAD_MS;
	expect(throttleTargetElapsedMs(written, rate)).toBeCloseTo(elapsedMs, 6);
	return written - elapsedMs * rate;
}

describe('throttleTargetElapsedMs', () => {
	it('generates the opening lead flat out', () => {
		expect(throttleTargetElapsedMs(RUN_AHEAD_LEAD_MS - 1, 1)).toBe(0);
		expect(throttleTargetElapsedMs(0, 2)).toBe(0);
	});

	it('holds the lead flat instead of letting it grow with listening time', () => {
		// The regression this replaces: a flat 2x rate meant the lead equalled the elapsed time,
		// so ten minutes in the browser was holding ten extra minutes of audio it could never
		// refetch (the stream serves no Range requests).
		for (const minutes of [1, 5, 10, 30]) {
			expect(leadAfter(minutes * 60_000, 1)).toBe(RUN_AHEAD_LEAD_MS);
		}
	});

	it('keeps the same lead at every playback speed', () => {
		for (const rate of [0.75, 1, 1.5, 2, 3]) {
			expect(leadAfter(10 * 60_000, rate)).toBe(RUN_AHEAD_LEAD_MS);
		}
	});

	it('stays ahead of a 2x listener', () => {
		// 90s of audio written, listener at 2x: they need 45s of wall clock for it, and the
		// throttle lets us write it in 0 — the full lead is still in hand.
		expect(throttleTargetElapsedMs(90_000, 2)).toBe(0);
		// Further in, we are allowed exactly the time that keeps the lead intact.
		expect(throttleTargetElapsedMs(290_000, 2)).toBe(100_000);
	});

	it('paces a slow listener more than a fast one', () => {
		expect(throttleTargetElapsedMs(300_000, 0.75)).toBeGreaterThan(
			throttleTargetElapsedMs(300_000, 1.5)
		);
	});

	it('treats an absurdly small rate as the floor rather than dividing by ~zero', () => {
		expect(Number.isFinite(throttleTargetElapsedMs(300_000, 0))).toBe(true);
		expect(throttleTargetElapsedMs(300_000, 0)).toBe(420_000);
	});
});

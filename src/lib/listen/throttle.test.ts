import { describe, expect, it } from 'vitest';
import {
	clampPlaybackRate,
	RUN_AHEAD_LEAD_MS,
	throttleTargetElapsedMs
} from './throttle';

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

describe('throttleTargetElapsedMs', () => {
	it('does not throttle at all inside the lead window', () => {
		expect(throttleTargetElapsedMs(RUN_AHEAD_LEAD_MS - 1, 1)).toBe(0);
		expect(throttleTargetElapsedMs(0, 2)).toBe(0);
	});

	it('keeps 2x headroom over a 1x listener', () => {
		// 90s of audio written: 30s free, the remaining 60s paced at 2x → 30s of wall clock.
		expect(throttleTargetElapsedMs(90_000, 1)).toBe(30_000);
	});

	it('stays ahead of a 2x listener instead of matching them', () => {
		// The old flat `writtenMs / 2` allowed 45s here — exactly the wall-clock time a 2x
		// listener needs for 90s of audio, so the buffer could never grow and playback stalled.
		const allowed = throttleTargetElapsedMs(90_000, 2);
		const listenerNeeds = 90_000 / 2;
		expect(allowed).toBeLessThan(listenerNeeds);
		expect(allowed).toBe(15_000);
	});

	it('gives a slow listener more throttling, not less', () => {
		expect(throttleTargetElapsedMs(90_000, 0.75)).toBeGreaterThan(
			throttleTargetElapsedMs(90_000, 1.5)
		);
	});

	it('treats an absurdly small rate as the floor rather than dividing by ~zero', () => {
		expect(Number.isFinite(throttleTargetElapsedMs(90_000, 0))).toBe(true);
		expect(throttleTargetElapsedMs(90_000, 0)).toBe(60_000);
	});
});

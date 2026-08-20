import { describe, expect, it } from 'vitest';
import {
	clampDocumentTime,
	documentOffsetSec,
	isSeekableTo,
	isUnrequestedRestart,
	seqAtDocumentTime,
	totalDurationSec
} from './timeline';

/** Four sentences of 10s, 5s, 20s, 5s → 40s total. */
const sentences = [
	{ duration_ms: 10_000 },
	{ duration_ms: 5_000 },
	{ duration_ms: 20_000 },
	{ duration_ms: 5_000 }
];

function ranges(...pairs: [number, number][]): TimeRanges {
	return {
		length: pairs.length,
		start: (i: number) => pairs[i][0],
		end: (i: number) => pairs[i][1]
	} as TimeRanges;
}

describe('totalDurationSec / documentOffsetSec', () => {
	it('sums the whole document', () => {
		expect(totalDurationSec(sentences)).toBe(40);
		expect(totalDurationSec([])).toBe(0);
	});

	it('returns where a sentence starts on the document timeline', () => {
		expect(documentOffsetSec(sentences, 0)).toBe(0);
		expect(documentOffsetSec(sentences, 2)).toBe(15);
		expect(documentOffsetSec(sentences, sentences.length)).toBe(40);
	});

	it('clamps an out-of-range seq instead of reading past the end', () => {
		expect(documentOffsetSec(sentences, 99)).toBe(40);
	});
});

describe('seqAtDocumentTime', () => {
	it('maps a position to the sentence being spoken', () => {
		expect(seqAtDocumentTime(sentences, 0)).toBe(0);
		expect(seqAtDocumentTime(sentences, 9.9)).toBe(0);
		expect(seqAtDocumentTime(sentences, 10)).toBe(1);
		expect(seqAtDocumentTime(sentences, 14.9)).toBe(1);
		expect(seqAtDocumentTime(sentences, 15)).toBe(2);
		expect(seqAtDocumentTime(sentences, 34.9)).toBe(2);
		expect(seqAtDocumentTime(sentences, 35)).toBe(3);
	});

	it('clamps past either end rather than falling off the document', () => {
		expect(seqAtDocumentTime(sentences, -30)).toBe(0);
		expect(seqAtDocumentTime(sentences, 9_999)).toBe(3);
		expect(seqAtDocumentTime([], 5)).toBe(0);
	});

	it('a −10s skip from inside a long sentence stays in that sentence', () => {
		// Playing at 30s (inside the 15s–35s sentence): −10s is 20s, still the same sentence,
		// which is what makes the lock-screen skip feel like a skip and not a chapter jump.
		expect(seqAtDocumentTime(sentences, 30 - 10)).toBe(2);
		// …and +10s from 30s crosses into the next one.
		expect(seqAtDocumentTime(sentences, 30 + 10)).toBe(3);
	});
});

describe('clampDocumentTime', () => {
	it('keeps targets inside the document', () => {
		expect(clampDocumentTime(sentences, -5)).toBe(0);
		expect(clampDocumentTime(sentences, 12)).toBe(12);
		expect(clampDocumentTime(sentences, 500)).toBe(40);
	});

	it('treats a non-finite target as the start', () => {
		expect(clampDocumentTime(sentences, Number.NaN)).toBe(0);
	});
});

describe('isSeekableTo', () => {
	it('accepts a target both seekable and buffered, with margin', () => {
		const el = { seekable: ranges([0, 30]), buffered: ranges([0, 30]) };
		expect(isSeekableTo(el, 12)).toBe(true);
		// Right at the buffered edge: refuse, a seek there just stalls again.
		expect(isSeekableTo(el, 30)).toBe(false);
	});

	it('rejects a target the element has not buffered', () => {
		const el = { seekable: ranges([0, 30]), buffered: ranges([0, 8]) };
		expect(isSeekableTo(el, 20)).toBe(false);
	});

	it('rejects everything on a live stream that reports nothing seekable', () => {
		const el = { seekable: ranges(), buffered: ranges([0, 30]) };
		expect(isSeekableTo(el, 5)).toBe(false);
	});
});

describe('isUnrequestedRestart', () => {
	it('recognises the element restarting the stream from the top', () => {
		expect(isUnrequestedRestart(412, 0)).toBe(true);
		expect(isUnrequestedRestart(65.4, 0.3)).toBe(true);
	});

	it('ignores ordinary forward playback', () => {
		expect(isUnrequestedRestart(30, 30.25)).toBe(false);
		expect(isUnrequestedRestart(0, 0.25)).toBe(false);
	});

	it('ignores a small backwards wobble around a stall', () => {
		expect(isUnrequestedRestart(120, 119.5)).toBe(false);
	});

	it('ignores a rewind that lands well inside the stream', () => {
		// A −10s skip from 2 minutes in is a real position, not a restart.
		expect(isUnrequestedRestart(120, 110)).toBe(false);
	});

	it('ignores the first seconds of a stream that has barely started', () => {
		expect(isUnrequestedRestart(4, 0)).toBe(false);
	});

	it('ignores non-finite clocks', () => {
		expect(isUnrequestedRestart(Number.NaN, 0)).toBe(false);
		expect(isUnrequestedRestart(100, Number.NaN)).toBe(false);
	});
});

import { describe, expect, it } from 'vitest';
import {
	assertSentenceCoverage,
	estimateDurationMsFromChars,
	estimateMp3DurationMs,
	hashSentence,
	splitIntoSentences
} from './sentences';

describe('splitIntoSentences', () => {
	it('returns nothing for empty input', () => {
		expect(splitIntoSentences('')).toEqual([]);
		expect(splitIntoSentences('   \n\n  ')).toEqual([]);
	});

	it('keeps a single short text as a single unit', () => {
		expect(splitIntoSentences('Hello world.')).toEqual(['Hello world.']);
	});

	it('preserves decimals, section numbers and abbreviations', () => {
		const text =
			'Klein c hoch p beschreibt 2.1.7 den Anteil. Version 1.2.3 ist da. Dr. Smith bleibt.';
		const units = splitIntoSentences(text);
		expect(units.join(' ').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
		expect(units.join(' ')).toContain('2.1.7');
		expect(units.join(' ')).toContain('1.2.3');
	});

	it('merges tiny sentences into the following one', () => {
		const text = 'Ja. Das ist ein längerer Satz, der locker über die Mindestlänge geht.';
		const units = splitIntoSentences(text);
		// "Ja." (3 chars) should merge with the next, not become its own unit.
		expect(units.length).toBe(1);
		expect(units[0]).toContain('Ja.');
	});

	it('does not merge two sufficiently long sentences', () => {
		const text =
			'Dieser erste Satz ist deutlich länger als die Mindestschwelle. ' +
			'Und auch dieser zweite Satz ist klar lang genug, allein zu stehen.';
		const units = splitIntoSentences(text);
		expect(units.length).toBe(2);
	});

	it('splits a single oversized sentence by words', () => {
		const word = 'foo';
		const huge = Array(2500).fill(word).join(' '); // ~10k chars, no terminators inside
		const units = splitIntoSentences(huge, { maxChars: 100 });
		for (const u of units) expect(u.length).toBeLessThanOrEqual(100);
		expect(units.join(' ').replace(/\s+/g, '')).toBe(huge.replace(/\s+/g, ''));
	});

	it('handles consecutive terminators like "Wait!! Really?"', () => {
		const text = 'Wait!! Really? Yes, this is fine and is plenty long enough to count as its own sentence.';
		const units = splitIntoSentences(text);
		expect(units.join(' ').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
	});

	it('normalizes CRLF line endings', () => {
		const text = 'First sentence here.\r\nSecond sentence here too with enough chars.';
		const units = splitIntoSentences(text);
		expect(units.length).toBeGreaterThan(0);
		expect(units.join(' ').replace(/\s+/g, '')).toBe(
			text.replace(/\r\n?/g, '\n').replace(/\s+/g, '')
		);
	});

	it('end-to-end: math-heavy German text passes coverage and order checks', () => {
		const text = [
			'In Abschnitt 2.1.7 betrachten wir den Staat. Klein c hoch p beschreibt den Anteil des privaten Konsums.',
			'Entsprechend folgt: k_t+1 = (1 - delta) k_t + i_t. Das ist die Kapitalakkumulation.',
			'Die Gleichung 2.1 zeigt das Output Y_t. Y_t = F(K_t, L_t). Dies entspricht dem Produktionsfaktoreneinsatz.'
		].join('\n\n');
		const units = splitIntoSentences(text);
		expect(() => assertSentenceCoverage(text, units)).not.toThrow();
		// Critical: 2.1.7, k_t+1, 2.1, Y_t must all be preserved verbatim somewhere.
		const joined = units.join(' ');
		for (const needle of ['2.1.7', 'k_t+1', '2.1', 'Y_t', 'K_t', 'L_t']) {
			expect(joined).toContain(needle);
		}
	});
});

describe('assertSentenceCoverage', () => {
	it('throws when content is missing', () => {
		expect(() => assertSentenceCoverage('Hello world this is fine', ['Hello'])).toThrow();
	});

	it('throws when content is reordered', () => {
		expect(() => assertSentenceCoverage('one two three', ['three', 'one', 'two'])).toThrow();
	});

	it('passes for correctly ordered, complete chunks', () => {
		expect(() =>
			assertSentenceCoverage('Hello world this is fine.', ['Hello world', 'this is fine.'])
		).not.toThrow();
	});

	it('ignores whitespace differences', () => {
		expect(() => assertSentenceCoverage('foo  bar\tbaz', ['foo bar', 'baz'])).not.toThrow();
	});
});

describe('hashSentence', () => {
	it('is stable across whitespace-only differences', async () => {
		const a = await hashSentence('Hello   world', 'v1', 'm1', 'de');
		const b = await hashSentence('Hello world', 'v1', 'm1', 'de');
		expect(a).toBe(b);
	});

	it('changes when voice, model, or language change', async () => {
		const base = await hashSentence('Hello world', 'v1', 'm1', 'de');
		expect(await hashSentence('Hello world', 'v2', 'm1', 'de')).not.toBe(base);
		expect(await hashSentence('Hello world', 'v1', 'm2', 'de')).not.toBe(base);
		expect(await hashSentence('Hello world', 'v1', 'm1', 'en')).not.toBe(base);
	});

	it('changes when meaningful text changes', async () => {
		const a = await hashSentence('Hello world', 'v1', 'm1', 'de');
		const b = await hashSentence('Goodbye world', 'v1', 'm1', 'de');
		expect(a).not.toBe(b);
	});

	it('matches the no-speed signature at speed 1 (cache backward-compat)', async () => {
		// Critical invariant: passing speed=1 must produce the same hash as omitting it, or
		// every existing cache row + listen_sentences row in production would silently miss.
		const noSpeed = await hashSentence('Hello world', 'v1', 'm1', 'de');
		const explicitOne = await hashSentence('Hello world', 'v1', 'm1', 'de', 1);
		expect(explicitOne).toBe(noSpeed);
	});

	it('changes when generation speed is non-default', async () => {
		const base = await hashSentence('Hello world', 'v1', 'm1', 'de');
		expect(await hashSentence('Hello world', 'v1', 'm1', 'de', 1.2)).not.toBe(base);
		expect(await hashSentence('Hello world', 'v1', 'm1', 'de', 0.8)).not.toBe(base);
	});
});

describe('mp3 duration estimates', () => {
	it('estimates 1 second per 16 KB at 128 kbps CBR', () => {
		expect(estimateMp3DurationMs(16_000)).toBe(1000);
		expect(estimateMp3DurationMs(8_000)).toBe(500);
	});

	it('estimates from char count using ~15 chars/sec', () => {
		// 150 chars at normal speed → ~10 seconds.
		expect(estimateDurationMsFromChars(150)).toBeGreaterThan(8_000);
		expect(estimateDurationMsFromChars(150)).toBeLessThan(12_000);
		// Speed 2× → half the duration.
		expect(estimateDurationMsFromChars(150, 2)).toBeLessThan(estimateDurationMsFromChars(150, 1));
	});
});

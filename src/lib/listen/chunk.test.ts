import { describe, expect, it } from 'vitest';
import { assertChunkCoverage, chunkText } from './chunk';

describe('chunkText', () => {
	it('returns nothing for empty input', () => {
		expect(chunkText('')).toEqual([]);
		expect(chunkText('   \n  ')).toEqual([]);
	});

	it('keeps short text as a single chunk', () => {
		expect(chunkText('Hello world.')).toEqual(['Hello world.']);
	});

	it('packs paragraphs greedily without exceeding maxChars', () => {
		const para = 'a'.repeat(40);
		const text = `${para}\n\n${para}\n\n${para}`;
		const chunks = chunkText(text, { maxChars: 100 });
		expect(chunks.every((c) => c.length <= 100)).toBe(true);
		// 3 × 40 + separators (4) = 124 > 100 → splits into 2 chunks
		expect(chunks.length).toBe(2);
	});

	it('splits a long paragraph on sentence boundaries', () => {
		const sentence = 'This is a sentence. ';
		const text = sentence.repeat(20).trim();
		const chunks = chunkText(text, { maxChars: 60 });
		expect(chunks.every((c) => c.length <= 60)).toBe(true);
		expect(chunks.length).toBeGreaterThan(1);
	});

	it('preserves decimals, version numbers and abbreviations when sentence-splitting', () => {
		const text = 'It costs 3.14 dollars. Version 1.2.3 is out. Dr. Smith left.';
		const chunks = chunkText(text, { maxChars: 30 });
		const joined = chunks.join(' ');
		// Every non-whitespace character of the original must survive.
		expect(joined.replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
		expect(joined).toContain('3.14');
		expect(joined).toContain('1.2.3');
	});

	it('handles consecutive terminators ("Wait!! Really?")', () => {
		const text = 'Wait!! Really? Yes.';
		const chunks = chunkText(text, { maxChars: 10 });
		expect(chunks.join(' ').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
	});

	it('never cuts a word when a single sentence is too long', () => {
		const text = 'alpha beta gamma delta epsilon zeta eta theta';
		const chunks = chunkText(text, { maxChars: 12 });
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(12);
			expect(text).toContain(chunk);
		}
	});

	it('hard-slices a single oversized token as a last resort', () => {
		const token = 'x'.repeat(50);
		const chunks = chunkText(token, { maxChars: 20 });
		expect(chunks).toEqual(['x'.repeat(20), 'x'.repeat(20), 'x'.repeat(10)]);
	});

	it('normalizes CRLF line endings', () => {
		expect(chunkText('Line one.\r\nLine two.')).toEqual(['Line one.\nLine two.']);
	});

	it('end-to-end: chunks cover all non-whitespace content of mixed prose', () => {
		const text = [
			'Intro paragraph with "quotes", numbers like 1.5 and Mr. Brown.',
			'Second paragraph! It has multiple? sentences. Yes...',
			'A list: e.g. apples, e.g. pears, e.g. grapes.'
		].join('\n\n');
		const chunks = chunkText(text, { maxChars: 40 });
		expect(chunks.every((c) => c.length <= 40)).toBe(true);
		expect(() => assertChunkCoverage(text, chunks)).not.toThrow();
	});
});

describe('assertChunkCoverage', () => {
	it('throws when chunks are missing content', () => {
		expect(() => assertChunkCoverage('Hello world', ['Hello'])).toThrow();
	});

	it('passes when whitespace differs but content is intact', () => {
		expect(() => assertChunkCoverage('Hello world', ['Hello', 'world'])).not.toThrow();
		expect(() => assertChunkCoverage('foo  bar', ['foo bar'])).not.toThrow();
	});
});

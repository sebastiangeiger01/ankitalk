import { describe, expect, it } from 'vitest';
import { chunkText } from './chunk';

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

	it('never cuts a word when a single sentence is too long', () => {
		const text = 'alpha beta gamma delta epsilon zeta eta theta';
		const chunks = chunkText(text, { maxChars: 12 });
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(12);
			// no chunk should contain a partial word for these short words
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
});

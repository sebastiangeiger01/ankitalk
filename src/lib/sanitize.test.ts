import { describe, expect, it } from 'vitest';
import {
	assertMaxBytes,
	isSafeMediaFilename,
	mediaContentTypeForFilename,
	sanitizeAndRewriteCardHtml,
	sanitizeCardHtml,
	sanitizePlainText
} from './sanitize';

describe('sanitizeCardHtml', () => {
	it('removes scripts, event handlers, and javascript URLs', () => {
		const result = sanitizeCardHtml(
			'<p onclick="steal()">Hello</p><script>alert(1)</script><a href="javascript:alert(1)">bad</a>'
		);

		expect(result).toContain('<p>Hello</p>');
		expect(result).toContain('>bad</a>');
		expect(result).not.toContain('script');
		expect(result).not.toContain('onclick');
		expect(result).not.toContain('javascript:');
	});

	it('keeps safe formatting while dropping unsafe inline styles', () => {
		const result = sanitizeCardHtml(
			'<span style="color: #123; position: absolute; font-weight: bold">safe</span>'
		);

		expect(result).toContain('color:#123');
		expect(result).toContain('font-weight:bold');
		expect(result).not.toContain('position');
	});

	it('rewrites safe local media and blanks unsafe local media paths', () => {
		const result = sanitizeAndRewriteCardHtml(
			'<img src="image.png"><audio src="./voice.mp3"></audio><img src="../secret.png">'
		);

		expect(result).toContain('src="/api/media/image.png"');
		expect(result).toContain('src="/api/media/voice.mp3"');
		expect(result).toContain('<img src="" />');
		expect(result).not.toContain('secret.png');
	});
});

describe('import safety helpers', () => {
	it('rejects path traversal, hidden files, control characters, and unsupported media types', () => {
		expect(isSafeMediaFilename('image.png')).toBe(true);
		expect(isSafeMediaFilename('../image.png')).toBe(false);
		expect(isSafeMediaFilename('.hidden.png')).toBe(false);
		expect(isSafeMediaFilename('folder/image.png')).toBe(false);
		expect(isSafeMediaFilename("bad'name.png")).toBe(false);
		expect(isSafeMediaFilename('bad\u0000name.png')).toBe(false);
		expect(mediaContentTypeForFilename('payload.svg')).toBeNull();
		expect(mediaContentTypeForFilename('clip.mp3')).toBe('audio/mpeg');
	});

	it('strips control characters from plain text and enforces byte limits', () => {
		expect(sanitizePlainText('  a\u0000b\u0007c  ', 10)).toBe('abc');
		expect(() => assertMaxBytes('abcdef', 5, 'Field')).toThrow('Field is too large');
	});
});

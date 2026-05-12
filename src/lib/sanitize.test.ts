import { describe, expect, it } from 'vitest';
import {
	assertMaxBytes,
	isSafeMediaFilename,
	mediaContentTypeForFilename,
	sanitizeAndRewriteCardHtml,
	sanitizeCardHtml,
	sanitizePlainText,
	sanitizeSvgMarkup
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
			'<img src="image.png"><audio src="./voice.mp3"></audio><img src="my image (final) ü.png"><img src="../secret.png">'
		);

		expect(result).toContain('src="/api/media/image.png"');
		expect(result).toContain('src="/api/media/voice.mp3"');
		expect(result).toContain('src="/api/media/my%20image%20(final)%20%C3%BC.png"');
		expect(result).toContain('<img src="" />');
		expect(result).not.toContain('secret.png');
	});
});

describe('import safety helpers', () => {
	it('accepts normal Anki media names while rejecting path-like names', () => {
		expect(isSafeMediaFilename('image.png')).toBe(true);
		expect(isSafeMediaFilename('my image (final).png')).toBe(true);
		expect(isSafeMediaFilename("O'Brien audio.mp3")).toBe(true);
		expect(isSafeMediaFilename('Kapitel übung 1.wav')).toBe(true);
		expect(isSafeMediaFilename('写真.svg')).toBe(true);
		expect(isSafeMediaFilename('../image.png')).toBe(false);
		expect(isSafeMediaFilename('.hidden.png')).toBe(false);
		expect(isSafeMediaFilename('folder/image.png')).toBe(false);
		expect(isSafeMediaFilename('C:evil.png')).toBe(false);
		expect(isSafeMediaFilename('bad\u0000name.png')).toBe(false);
		expect(mediaContentTypeForFilename('payload.svg')).toBe('image/svg+xml');
		expect(mediaContentTypeForFilename('clip.mp3')).toBe('audio/mpeg');
	});

	it('sanitizes SVG media before upload/storage', () => {
		const unsafeSvg = `
			<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)">
				<script>alert(1)</script>
				<foreignObject><body onload="alert(2)">bad</body></foreignObject>
				<linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient>
				<image href="https://tracker.test/pixel.png"/>
				<circle cx="5" cy="5" r="4" fill="url(#g)" style="stroke: #123; background-image: url(https://tracker.test/x)"/>
				<set attributeName="href" to="https://tracker.test/late.png"/>
				<a href="javascript:alert(3)"><text>label</text></a>
			</svg>
		`;

		const text = sanitizeSvgMarkup(unsafeSvg);
		expect(text).toContain('<svg');
		expect(text).toContain('viewBox="0 0 10 10"');
		expect(text).toContain('fill="url(#g)"');
		expect(text).toContain('stroke:#123');
		expect(text).not.toContain('script');
		expect(text).not.toContain('onload');
		expect(text).not.toContain('foreignObject');
		expect(text).not.toContain('https://tracker.test');
		expect(text).not.toContain('javascript:');
	});

	it('strips control characters from plain text and enforces byte limits', () => {
		expect(sanitizePlainText('  a\u0000b\u0007c  ', 10)).toBe('abc');
		expect(() => assertMaxBytes('abcdef', 5, 'Field')).toThrow('Field is too large');
	});
});

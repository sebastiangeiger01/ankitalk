import { describe, expect, it } from 'vitest';
import { contentDisposition, downloadFilename, stripId3v2 } from './mp3';

/** An ID3v2 header with the given body length, followed by `payload`. */
function withId3(payload: number[], bodyLength: number, flags = 0): Uint8Array {
	const size = [
		(bodyLength >> 21) & 0x7f,
		(bodyLength >> 14) & 0x7f,
		(bodyLength >> 7) & 0x7f,
		bodyLength & 0x7f
	];
	return new Uint8Array([
		0x49, 0x44, 0x33, // "ID3"
		0x04, 0x00, // version
		flags,
		...size,
		...new Array(bodyLength).fill(0xaa), // tag body
		...payload
	]);
}

/** The start of a real MP3 frame: sync word plus a plausible header byte. */
const FRAME = [0xff, 0xfb, 0x90, 0x64];

describe('stripId3v2', () => {
	it('removes a tag and returns the frames after it', () => {
		expect([...stripId3v2(withId3(FRAME, 32))]).toEqual(FRAME);
	});

	it('accounts for the optional footer', () => {
		const withFooter = withId3([...new Array(10).fill(0), ...FRAME], 32, 0x10);
		expect([...stripId3v2(withFooter)]).toEqual(FRAME);
	});

	it('decodes syncsafe lengths rather than plain big-endian ones', () => {
		// 200 needs two syncsafe bytes (0x01,0x48); reading it as big-endian would give 328
		// and swallow the first 128 bytes of audio.
		expect([...stripId3v2(withId3(FRAME, 200))]).toEqual(FRAME);
	});

	it('leaves untagged audio untouched, including the same array instance', () => {
		const raw = new Uint8Array([...FRAME, 0x11, 0x22]);
		expect(stripId3v2(raw)).toBe(raw);
	});

	it('leaves a buffer that merely starts with other bytes untouched', () => {
		const raw = new Uint8Array([0x49, 0x44, 0x34, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
		expect(stripId3v2(raw)).toBe(raw);
	});

	it('rejects a header whose length bytes are not syncsafe', () => {
		const bogus = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0x80, 0, 0, 0, ...FRAME]);
		expect(stripId3v2(bogus)).toBe(bogus);
	});

	it('handles a buffer that is nothing but a tag', () => {
		expect(stripId3v2(withId3([], 16))).toHaveLength(0);
	});

	it('handles a truncated buffer without reading past the end', () => {
		expect(stripId3v2(new Uint8Array([0x49, 0x44, 0x33]))).toHaveLength(3);
		expect(stripId3v2(new Uint8Array(0))).toHaveLength(0);
	});
});

describe('downloadFilename', () => {
	it('keeps a readable title, umlauts and all', () => {
		expect(downloadFilename('Kapitel 3 — Wärmeübertragung')).toBe('Kapitel 3 — Wärmeübertragung.mp3');
	});

	it('strips path separators and other filesystem-hostile characters', () => {
		expect(downloadFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j.mp3');
	});

	it('strips control characters that could forge a header', () => {
		expect(downloadFilename('one\r\ntwo')).toBe('one two.mp3');
	});

	it('never produces a dotfile or a name ending in a dot or space', () => {
		expect(downloadFilename('...hidden')).toBe('hidden.mp3');
		expect(downloadFilename('trailing.  ')).toBe('trailing.mp3');
	});

	it('falls back when the title has nothing usable left', () => {
		expect(downloadFilename('   ')).toBe('audio.mp3');
		expect(downloadFilename('///')).toBe('audio.mp3');
	});

	it('truncates a very long title without leaving trailing padding', () => {
		const name = downloadFilename('x'.repeat(500));
		expect(name).toBe(`${'x'.repeat(80)}.mp3`);
	});
});

describe('contentDisposition', () => {
	it('offers an ASCII fallback alongside the UTF-8 name', () => {
		expect(contentDisposition('Wärme.mp3')).toBe(
			'attachment; filename="W_rme.mp3"; filename*=UTF-8\'\'W%C3%A4rme.mp3'
		);
	});

	it('neutralises quotes and backslashes in the fallback', () => {
		expect(contentDisposition('a"b\\c.mp3')).toContain('filename="a_b_c.mp3"');
	});
});

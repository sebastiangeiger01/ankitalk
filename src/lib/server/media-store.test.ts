// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
	decodeBase64Image,
	extractMediaFilenames,
	imageExtension,
	isImageFilename,
	storeUserImage,
	verifyImageIntegrity
} from './media-store';

const textBytes = (s: string) => new TextEncoder().encode(s);
const toB64 = (s: string) => Buffer.from(s).toString('base64');

describe('decodeBase64Image', () => {
	it('decodes standard base64 (with a data: prefix and whitespace)', () => {
		const b64 = toB64('hello');
		expect(decodeBase64Image(`data:image/png;base64, ${b64}\n`)).toEqual(textBytes('hello'));
	});

	it('accepts URL-safe and unpadded base64', () => {
		const standard = Buffer.from([0xfb, 0xff, 0xbf]).toString('base64'); // contains + and /
		const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		expect(decodeBase64Image(urlSafe)).toEqual(new Uint8Array([0xfb, 0xff, 0xbf]));
	});

	it('returns null for an impossible base64 length (likely truncated)', () => {
		expect(decodeBase64Image('abcde')).toBeNull(); // length % 4 === 1
	});
});

describe('verifyImageIntegrity', () => {
	const bytes = textBytes('hello');

	it('passes when size and sha256 match', async () => {
		const sha = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
		expect(await verifyImageIntegrity(bytes, { sizeBytes: 5, sha256: sha })).toBeNull();
	});

	it('reports a size mismatch (truncation) clearly', async () => {
		const reason = await verifyImageIntegrity(bytes, { sizeBytes: 999 });
		expect(reason).toMatch(/decoded 5 bytes but expected 999/);
	});

	it('reports a checksum mismatch', async () => {
		const reason = await verifyImageIntegrity(bytes, { sha256: 'f'.repeat(64) });
		expect(reason).toMatch(/sha256 mismatch/);
	});
});

describe('extractMediaFilenames', () => {
	it('pulls bare filenames from img/audio/source tags', () => {
		const html = '<p>see <img src="abc.png" alt="x"> and <audio src="clip.mp3"></audio></p>';
		expect(extractMediaFilenames(html).sort()).toEqual(['abc.png', 'clip.mp3']);
	});

	it('unwraps already-rewritten /api/media URLs and dedupes', () => {
		const html = '<img src="/api/media/abc.png"><img src="abc.png">';
		expect(extractMediaFilenames(html)).toEqual(['abc.png']);
	});

	it('skips external and data sources', () => {
		const html = '<img src="https://example.com/a.png"><img src="data:image/png;base64,AAAA">';
		expect(extractMediaFilenames(html)).toEqual([]);
	});
});

function fakeBucket() {
	const store = new Map<string, { body: Uint8Array; contentType?: string }>();
	const bucket = {
		put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
			const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
			store.set(key, { body: bytes, contentType: opts?.httpMetadata?.contentType });
			return Promise.resolve();
		}
	} as unknown as R2Bucket;
	return { bucket, store };
}

describe('imageExtension / isImageFilename', () => {
	it('accepts raster and svg extensions case-insensitively', () => {
		expect(imageExtension('Figure.PNG')).toBe('png');
		expect(imageExtension('diagram.svg')).toBe('svg');
		expect(isImageFilename('a.webp')).toBe(true);
	});

	it('rejects non-image and extensionless names', () => {
		expect(imageExtension('audio.mp3')).toBeNull();
		expect(isImageFilename('notes.pdf')).toBe(false);
		expect(isImageFilename('plainname')).toBe(false);
	});
});

describe('storeUserImage', () => {
	it('content-addresses the stored file under the user namespace', async () => {
		const { bucket, store } = fakeBucket();
		const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]); // arbitrary "png" bytes
		const result = await storeUserImage(bucket, 'user-1', 'photo.png', bytes);

		expect(result.filename).toMatch(/^[0-9a-f]{64}\.png$/);
		expect(result.contentType).toBe('image/png');
		expect(store.has(`user-1/${result.filename}`)).toBe(true);
	});

	it('is idempotent: identical bytes yield the same filename', async () => {
		const { bucket } = fakeBucket();
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		const a = await storeUserImage(bucket, 'user-1', 'x.gif', bytes);
		const b = await storeUserImage(bucket, 'user-1', 'y.gif', new Uint8Array([1, 2, 3, 4, 5]));
		expect(a.filename).toBe(b.filename);
	});

	it('sanitizes SVG before storing (strips scripts)', async () => {
		const { bucket, store } = fakeBucket();
		const dirty = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>';
		const result = await storeUserImage(bucket, 'user-1', 'd.svg', new TextEncoder().encode(dirty));

		expect(result.contentType).toBe('image/svg+xml');
		const stored = new TextDecoder().decode(store.get(`user-1/${result.filename}`)!.body);
		expect(stored).not.toContain('<script');
		expect(stored).toContain('<rect');
	});

	it('rejects an unsupported image type', async () => {
		const { bucket } = fakeBucket();
		await expect(storeUserImage(bucket, 'user-1', 'clip.mp4', new Uint8Array([0]))).rejects.toThrow(/Unsupported image type/);
	});
});

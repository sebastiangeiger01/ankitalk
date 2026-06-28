// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { imageExtension, isImageFilename, storeUserImage } from './media-store';

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

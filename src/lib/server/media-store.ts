/**
 * Shared image-media storage used by both the web upload endpoint (`POST /api/media`) and the
 * MCP `attach_image` tool, so human- and agent-authored cards land in exactly the same place
 * with the same validation and sanitization.
 *
 * Files are content-addressed: the stored filename is `sha256(sanitized bytes).ext`. That makes
 * uploads idempotent (the same image re-uploaded reuses the same key) and avoids one card's
 * upload overwriting another's. R2 keys are namespaced per user (`${userId}/${filename}`), and
 * reads are user-scoped in `/api/media/[key]`.
 */
import { IMPORT_LIMITS, isSafeMediaFilename, mediaContentTypeForFilename, sanitizeMediaBytes } from '$lib/sanitize';

/** Extensions accepted by the image-upload paths (raster + sanitized SVG). */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] as const;

export function imageExtension(filename: string): string | null {
	const ext = filename.split('.').pop()?.toLowerCase() ?? '';
	return (IMAGE_EXTENSIONS as readonly string[]).includes(ext) ? ext : null;
}

export function isImageFilename(filename: string): boolean {
	return imageExtension(filename) !== null;
}

/** Human-readable error for a filename that is not a supported image type. */
export function imageTypeError(filename: string): string {
	return `Unsupported image type: ${filename}. Supported types are PNG, JPG, GIF, WebP, BMP, and SVG.`;
}

/**
 * Extract the bare media filenames referenced by `<img|audio|source src="...">` in card HTML.
 * Skips external (`http(s):`, `data:`) and foreign-path sources; unwraps already-rewritten
 * `/api/media/<name>` URLs back to the filename. Used to check that a card's media resolves.
 */
export function extractMediaFilenames(html: string): string[] {
	const out = new Set<string>();
	const re = /<(?:img|audio|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(html)) !== null) {
		let src = match[1].trim();
		if (/^https?:\/\//i.test(src) || /^data:/i.test(src)) continue;
		const api = src.match(/^\/api\/media\/([^/?#]+)$/);
		if (api) src = decodeURIComponent(api[1]);
		if (src.includes('/') || src.includes('\\')) continue;
		if (isSafeMediaFilename(src)) out.add(src);
	}
	return [...out];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	const digest = await crypto.subtle.digest('SHA-256', view);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Decode a base64 image payload to bytes, tolerantly: strips a `data:` URL prefix and whitespace,
 * accepts the URL-safe alphabet (`-`/`_`), and re-pads. Returns null if the string still isn't
 * valid base64 (e.g. truncated in transit), so callers can surface a clear error.
 */
export function decodeBase64Image(value: string): Uint8Array | null {
	let s = value
		.replace(/^data:[^;,]*;base64,/, '')
		.replace(/\s+/g, '')
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.replace(/=+$/, '');
	const remainder = s.length % 4;
	if (remainder === 1) return null; // never a valid base64 length
	if (remainder !== 0) s += '='.repeat(4 - remainder);
	try {
		const binary = atob(s);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

/**
 * Verify decoded image bytes against optional caller-supplied expectations, so a payload corrupted
 * or truncated in transit fails loudly. Returns a human-readable reason on mismatch, or null if ok.
 */
export async function verifyImageIntegrity(
	bytes: Uint8Array,
	expected: { sha256?: string; sizeBytes?: number }
): Promise<string | null> {
	if (expected.sizeBytes !== undefined && bytes.byteLength !== expected.sizeBytes) {
		return `decoded ${bytes.byteLength} bytes but expected ${expected.sizeBytes} — the upload was likely truncated or corrupted in transit; re-encode and retry`;
	}
	if (expected.sha256) {
		const actual = await sha256Hex(bytes);
		if (actual.toLowerCase() !== expected.sha256.toLowerCase()) {
			return `sha256 mismatch (got ${actual.slice(0, 12)}…, expected ${expected.sha256.slice(0, 12)}…) — the upload was corrupted in transit; re-encode and retry`;
		}
	}
	return null;
}

export interface StoredImage {
	/** Content-addressed filename to embed as `<img src="...">` in a card field. */
	filename: string;
	contentType: string;
	bytes: number;
}

/**
 * Validate, sanitize, and store one image for a user. `sourceName` only supplies the file
 * extension (which selects the raster-vs-SVG sanitize branch); the stored name is derived from
 * the content hash. Throws on an unsupported type or an oversized file.
 */
export async function storeUserImage(
	bucket: R2Bucket,
	userId: string,
	sourceName: string,
	input: Uint8Array
): Promise<StoredImage> {
	const ext = imageExtension(sourceName);
	if (!ext) throw new Error(imageTypeError(sourceName));
	if (input.byteLength > IMPORT_LIMITS.maxMediaFileBytes) {
		throw new Error(`Image is too large (max ${Math.floor(IMPORT_LIMITS.maxMediaFileBytes / (1024 * 1024))} MB).`);
	}

	// sanitizeMediaBytes strips dangerous SVG content (and validates SVG size); raster bytes pass
	// through unchanged but with a verified content type.
	const blob = sanitizeMediaBytes(`upload.${ext}`, input);
	const clean = new Uint8Array(await blob.arrayBuffer());
	const contentType = blob.type || mediaContentTypeForFilename(`x.${ext}`) || 'application/octet-stream';

	const filename = `${await sha256Hex(clean)}.${ext}`;
	await bucket.put(`${userId}/${filename}`, clean, { httpMetadata: { contentType } });

	return { filename, contentType, bytes: clean.byteLength };
}

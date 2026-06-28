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
import { IMPORT_LIMITS, mediaContentTypeForFilename, sanitizeMediaBytes } from '$lib/sanitize';

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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	const digest = await crypto.subtle.digest('SHA-256', view);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
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

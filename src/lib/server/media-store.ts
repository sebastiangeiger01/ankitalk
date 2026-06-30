/**
 * Shared image-media storage used by the web upload endpoint (`POST /api/media`), the direct
 * capability-token upload (`PUT /api/media/upload/[token]`), and the MCP `attach_image_from_url`
 * tool — so human- and agent-authored cards land in exactly the same place with the same
 * validation and sanitization.
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

const CONTENT_TYPE_EXTENSION: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/bmp': 'bmp',
	'image/svg+xml': 'svg'
};

/** Pick an image extension for a fetched URL: from the path first, then the response content-type. */
export function imageExtensionFromUrl(url: string, contentType: string | null): string | null {
	try {
		const ext = imageExtension(new URL(url).pathname);
		if (ext) return ext;
	} catch {
		// fall through to content-type
	}
	if (contentType) {
		const base = contentType.split(';')[0].trim().toLowerCase();
		return CONTENT_TYPE_EXTENSION[base] ?? null;
	}
	return null;
}

/**
 * Denylist of literal hostnames/IP literals that must never be fetched. NOTE: this only inspects the
 * literal host in the URL — it does NOT resolve DNS, so a public hostname that resolves to a private
 * IP (DNS-rebinding SSRF) is not caught here. On Cloudflare Workers that vector is largely moot:
 * `fetch` egresses through Cloudflare's edge, not a local/VPC network, and there is no link-local
 * metadata service to reach. If this code is ever ported to Node/a server with private-network reach,
 * add post-resolution IP checks (or an allowlist) before relying on it.
 */
function isBlockedFetchHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
	// IPv6 loopback / unique-local / link-local literals.
	if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
	// IPv4 literals in loopback / link-local (incl. cloud metadata 169.254.169.254) / private / reserved ranges.
	const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (ipv4) {
		const a = Number(ipv4[1]);
		const b = Number(ipv4[2]);
		if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
	}
	return false;
}

/** Timeout for a single remote-image fetch. */
export const FETCH_IMAGE_TIMEOUT_MS = 10_000;

/**
 * Fetch a remote image over HTTPS for ingestion, with SSRF guards: https-only, no redirects
 * (a redirect could point at an internal host), and a literal-host denylist for loopback/private/
 * link-local/metadata addresses. Caps the response at `maxBytes`. Returns the bytes + content-type
 * or a human-readable error.
 */
export async function fetchRemoteImage(
	url: string,
	maxBytes: number
): Promise<{ ok: true; bytes: Uint8Array; contentType: string | null } | { ok: false; error: string }> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, error: 'URL is not valid.' };
	}
	if (parsed.protocol !== 'https:') return { ok: false, error: 'Only https:// URLs are allowed.' };
	if (isBlockedFetchHost(parsed.hostname)) return { ok: false, error: 'That host is not allowed.' };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_IMAGE_TIMEOUT_MS);
	try {
		const response = await fetch(parsed.toString(), {
			method: 'GET',
			redirect: 'error',
			signal: controller.signal,
			headers: { accept: 'image/*' }
		});
		if (!response.ok) return { ok: false, error: `Fetch failed with HTTP ${response.status}.` };
		const declared = response.headers.get('content-length');
		if (declared && Number(declared) > maxBytes) return { ok: false, error: 'Remote image exceeds the size limit.' };
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > maxBytes) return { ok: false, error: 'Remote image exceeds the size limit.' };
		return { ok: true, bytes, contentType: response.headers.get('content-type') };
	} catch (err) {
		const aborted = err instanceof Error && err.name === 'AbortError';
		return { ok: false, error: aborted ? 'Fetch timed out.' : 'Could not fetch the URL.' };
	} finally {
		clearTimeout(timer);
	}
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

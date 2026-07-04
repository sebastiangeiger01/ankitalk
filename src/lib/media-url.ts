/**
 * Pure media-filename + media-URL helpers with no HTML-sanitizer dependency.
 *
 * These live apart from `$lib/sanitize` (which pulls in the heavy `sanitize-html`) so the
 * browser-side card sanitizer can reuse the media-URL rewrite without bundling `sanitize-html`.
 * `$lib/sanitize` re-exports these for existing server/import callers.
 */

const textEncoder = new TextEncoder();

// Mirrors IMPORT_LIMITS.maxFilenameBytes in $lib/sanitize; kept local to avoid a circular import.
const MAX_MEDIA_FILENAME_BYTES = 240;

// Control characters (C0 range + DEL). Built via new RegExp to avoid literal control bytes in source.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]');

export function byteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}

export function mediaFilenameSafetyError(filename: string): string | null {
	if (!filename) return 'Media filename is empty';
	if (filename !== filename.trim()) {
		return `Media filename has leading or trailing whitespace: ${filename}`;
	}
	if (byteLength(filename) > MAX_MEDIA_FILENAME_BYTES) {
		return `Media filename is too long: ${filename}`;
	}
	if (CONTROL_CHARS.test(filename)) {
		return `Media filename contains control characters: ${filename}`;
	}
	if (filename.startsWith('.') || filename.endsWith('.')) {
		return `Media filename must not start or end with a dot: ${filename}`;
	}
	if (filename.includes('..')) {
		return `Media filename contains path traversal (".."): ${filename}`;
	}
	if (filename.includes('/') || filename.includes('\\')) {
		return `Media filename must not include folders or path separators: ${filename}`;
	}
	if (filename.includes(':')) {
		return `Media filename must not include drive or URL separators (:): ${filename}`;
	}
	if (/[<>|?*"`]/g.test(filename)) {
		return `Media filename contains unsupported filesystem characters: ${filename}`;
	}
	return null;
}

export function isSafeMediaFilename(filename: string): boolean {
	return mediaFilenameSafetyError(filename) === null;
}

function normalizeMediaFilename(filename: string): string | null {
	const trimmed = filename.trim().replace(/^\.\//, '');
	if (!isSafeMediaFilename(trimmed)) return null;
	return trimmed;
}

const ENTITY_PATTERN = /&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos|nbsp));/gi;
const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' '
};

/**
 * Decode HTML character references in an attribute value extracted via regex. The sanitizer
 * re-serializes `src="a&b.png"` as `src="a&amp;b.png"`, so a raw regex capture yields the
 * ENCODED text — using it as an R2 key / URL breaks every filename containing `&`. Single-pass
 * replacement so double-encoded input ("&amp;amp;") decodes exactly one level, like a browser.
 */
export function decodeHtmlEntities(value: string): string {
	if (!value.includes('&')) return value;
	return value.replace(ENTITY_PATTERN, (match, hex, dec, name) => {
		if (hex || dec) {
			const codePoint = hex ? parseInt(hex, 16) : parseInt(dec, 10);
			if (!Number.isFinite(codePoint) || codePoint > 0x10ffff) return match;
			try {
				return String.fromCodePoint(codePoint);
			} catch {
				return match;
			}
		}
		return NAMED_ENTITIES[name.toLowerCase()] ?? match;
	});
}

export function rewriteMediaUrls(html: string): string {
	return html.replace(
		/(<(?:img|audio|source)\b[^>]*\bsrc\s*=\s*["'])(?!https?:\/\/|\/api\/|data:)([^"']+)(["'])/gi,
		(_match, prefix, filename, suffix) => {
			const normalized = normalizeMediaFilename(decodeHtmlEntities(filename));
			if (!normalized) return `${prefix}${suffix}`;
			return `${prefix}/api/media/${encodeURIComponent(normalized)}${suffix}`;
		}
	);
}

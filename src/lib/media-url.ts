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

export function rewriteMediaUrls(html: string): string {
	return html.replace(
		/(<(?:img|audio|source)\b[^>]*\bsrc\s*=\s*["'])(?!https?:\/\/|\/api\/|data:)([^"']+)(["'])/gi,
		(_match, prefix, filename, suffix) => {
			const normalized = normalizeMediaFilename(filename);
			if (!normalized) return `${prefix}${suffix}`;
			return `${prefix}/api/media/${encodeURIComponent(normalized)}${suffix}`;
		}
	);
}

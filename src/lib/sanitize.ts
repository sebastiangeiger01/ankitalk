import sanitizeHtml from 'sanitize-html';

export const IMPORT_LIMITS = {
	maxApkgBytes: 100 * 1024 * 1024,
	maxUnzippedBytes: 300 * 1024 * 1024,
	maxDecks: 500,
	maxNotes: 100_000,
	maxCards: 200_000,
	maxFieldsPerNote: 50,
	maxFieldBytes: 256 * 1024,
	maxTagsBytes: 8 * 1024,
	maxMediaFiles: 5_000,
	maxMediaFileBytes: 25 * 1024 * 1024,
	maxMediaTotalBytes: 200 * 1024 * 1024,
	maxFilenameBytes: 240
} as const;

const textEncoder = new TextEncoder();

const colorPattern =
	/^(#[0-9a-f]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)|[a-z]+)$/i;

export function byteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}

export function assertMaxBytes(value: string, maxBytes: number, label: string): void {
	if (byteLength(value) > maxBytes) {
		throw new Error(`${label} is too large`);
	}
}

export function sanitizePlainText(value: unknown, maxBytes = IMPORT_LIMITS.maxFieldBytes): string {
	const text = String(value ?? '')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
		.trim();
	assertMaxBytes(text, maxBytes, 'Text');
	return text;
}

export function isSafeMediaFilename(filename: string): boolean {
	if (!filename) return false;
	if (byteLength(filename) > IMPORT_LIMITS.maxFilenameBytes) return false;
	if (/[\u0000-\u001f\u007f]/.test(filename)) return false;
	if (filename.startsWith('.') || filename.includes('..')) return false;
	if (filename.includes('/') || filename.includes('\\')) return false;
	if (filename.includes(':')) return false;
	if (/[<>|?*"'`]/g.test(filename)) return false;
	return true;
}

export function mediaContentTypeForFilename(filename: string): string | null {
	const ext = filename.split('.').pop()?.toLowerCase();
	switch (ext) {
		case 'png':
			return 'image/png';
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'gif':
			return 'image/gif';
		case 'webp':
			return 'image/webp';
		case 'bmp':
			return 'image/bmp';
		case 'mp3':
			return 'audio/mpeg';
		case 'wav':
			return 'audio/wav';
		case 'ogg':
		case 'oga':
			return 'audio/ogg';
		case 'm4a':
			return 'audio/mp4';
		case 'aac':
			return 'audio/aac';
		case 'flac':
			return 'audio/flac';
		case 'opus':
			return 'audio/opus';
		case 'mp4':
			return 'video/mp4';
		case 'webm':
			return 'video/webm';
		default:
			return null;
	}
}

function normalizeMediaFilename(filename: string): string | null {
	const trimmed = filename.trim().replace(/^\.\//, '');
	if (!isSafeMediaFilename(trimmed)) return null;
	return trimmed;
}

export function sanitizeCardHtml(value: unknown): string {
	const html = String(value ?? '');
	assertMaxBytes(html, IMPORT_LIMITS.maxFieldBytes, 'Card field');

	return sanitizeHtml(html, {
		allowedTags: [
			'a',
			'abbr',
			'audio',
			'b',
			'blockquote',
			'br',
			'caption',
			'code',
			'col',
			'colgroup',
			'dd',
			'del',
			'div',
			'dl',
			'dt',
			'em',
			'h1',
			'h2',
			'h3',
			'h4',
			'h5',
			'h6',
			'hr',
			'i',
			'img',
			'ins',
			'kbd',
			'li',
			'mark',
			'ol',
			'p',
			'pre',
			'q',
			'rb',
			'rp',
			'rt',
			'rtc',
			'ruby',
			's',
			'samp',
			'small',
			'source',
			'span',
			'strong',
			'sub',
			'sup',
			'table',
			'tbody',
			'td',
			'tfoot',
			'th',
			'thead',
			'tr',
			'u',
			'ul'
		],
		allowedAttributes: {
			a: ['href', 'name', 'rel', 'title'],
			audio: ['src', 'controls', 'title'],
			img: ['src', 'alt', 'title', 'width', 'height'],
			source: ['src', 'type'],
			'*': ['class', 'dir', 'lang', 'style', 'title']
		},
		allowedSchemes: ['http', 'https', 'mailto'],
		allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
		allowProtocolRelative: false,
		disallowedTagsMode: 'discard',
		parseStyleAttributes: true,
		allowedStyles: {
			'*': {
				color: [colorPattern],
				'background-color': [colorPattern],
				'font-size': [/^\d+(\.\d+)?(px|em|rem|%)$/],
				'font-style': [/^(italic|normal|oblique)$/],
				'font-weight': [/^(normal|bold|bolder|lighter|[1-9]00)$/],
				'text-align': [/^(left|right|center|justify|start|end)$/],
				'text-decoration': [/^(none|underline|line-through|overline)$/],
				'vertical-align': [/^(baseline|sub|super|text-top|text-bottom|middle|top|bottom)$/],
				'white-space': [/^(normal|nowrap|pre|pre-wrap|pre-line)$/]
			}
		},
		transformTags: {
			a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true)
		}
	}).trim();
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

export function sanitizeAndRewriteCardHtml(value: unknown): string {
	return rewriteMediaUrls(sanitizeCardHtml(value));
}

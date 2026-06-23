import DOMPurify from 'dompurify';
import { rewriteMediaUrls } from '$lib/media-url';
import type { CardHtmlSanitizer } from './card-renderer';

/**
 * Browser-side card sanitizer backed by DOMPurify (native parsing — small and fast) instead
 * of the ~240 kB `sanitize-html` bundle used on the server. The allowlist mirrors
 * `sanitizeCardHtml` in `$lib/sanitize` so rendered cards look the same; DOMPurify handles
 * stripping scripts, event handlers, and dangerous URLs/CSS.
 */
const ALLOWED_TAGS = [
	'a', 'abbr', 'audio', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
	'dd', 'del', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
	'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rb', 'rp', 'rt', 'rtc',
	'ruby', 's', 'samp', 'small', 'source', 'span', 'strong', 'sub', 'sup', 'table',
	'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'
];

const ALLOWED_ATTR = [
	'href', 'name', 'rel', 'title', 'src', 'controls', 'alt', 'width', 'height', 'type',
	'class', 'dir', 'lang', 'style', 'cite'
];

let hookInstalled = false;
function ensureHook(): void {
	if (hookInstalled) return;
	// Match the server sanitizer, which forces rel="noopener noreferrer" on links.
	DOMPurify.addHook('afterSanitizeAttributes', (node) => {
		if (node.nodeName === 'A' && node.hasAttribute('href')) {
			node.setAttribute('rel', 'noopener noreferrer');
		}
	});
	hookInstalled = true;
}

function sanitizeCardHtml(value: unknown): string {
	ensureHook();
	return DOMPurify.sanitize(String(value ?? ''), {
		ALLOWED_TAGS,
		ALLOWED_ATTR,
		ALLOW_DATA_ATTR: false
	}).trim();
}

function toText(value: unknown): string {
	return DOMPurify.sanitize(String(value ?? ''), { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
		.replace(/\s+/g, ' ')
		.trim();
}

export const clientCardSanitizer: CardHtmlSanitizer = {
	sanitizeAndRewrite: (html) => rewriteMediaUrls(sanitizeCardHtml(html)),
	toText
};

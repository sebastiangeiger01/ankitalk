import sanitizeHtml from 'sanitize-html';
import { sanitizeAndRewriteCardHtml, sanitizeCardHtml } from '$lib/sanitize';
import type { CardHtmlSanitizer } from '$lib/client/card-renderer';

/**
 * Server-side card sanitizer backed by `sanitize-html` (no DOM needed in Workers). Used when
 * cards are rendered server-side (study context, card-authoring previews). The browser uses
 * the lighter DOMPurify adapter in `$lib/client/card-sanitize`.
 */
export const serverCardSanitizer: CardHtmlSanitizer = {
	sanitizeAndRewrite: (html) => sanitizeAndRewriteCardHtml(html),
	toText: (html) =>
		sanitizeHtml(sanitizeCardHtml(html), { allowedTags: [], allowedAttributes: {} })
			.replace(/\s+/g, ' ')
			.trim()
};

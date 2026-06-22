import { error } from '@sveltejs/kit';

/**
 * Maximum size of a single card field passed to an LLM. ~8 KB is plenty for any reasonable
 * card front/back, and bounds the input-token bill against a runaway-or-malicious request.
 */
export const MAX_CARD_FIELD_CHARS = 8000;

/** Whitelist of locales we actually translate prompts for. Anything else gets dropped to
 *  the explainCard/hintCard defaults rather than passed through into a prompt unchecked. */
const SUPPORTED_LOCALES = new Set(['en', 'de']);

export function normalizeLocale(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	return SUPPORTED_LOCALES.has(value) ? value : undefined;
}

/**
 * Validate a card-field input and return its trimmed value, or throw a 400. Catches both
 * missing/empty (the old behavior) and the new "too long" case so an LLM call site can be
 * one line.
 */
export function requireField(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw error(400, `Missing ${name}`);
	}
	if (value.length > MAX_CARD_FIELD_CHARS) {
		throw error(413, `${name} is too long (max ${MAX_CARD_FIELD_CHARS} characters)`);
	}
	return value;
}

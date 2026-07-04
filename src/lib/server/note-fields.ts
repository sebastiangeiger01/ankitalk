import { error } from '@sveltejs/kit';
import { IMPORT_LIMITS, assertMaxBytes, sanitizeCardHtml, sanitizePlainText } from '$lib/sanitize';

/**
 * Validate and sanitize note fields before they are persisted. Shared by the apkg import and
 * the card create/edit endpoints so every write path enforces the same shape, size limits, and
 * HTML sanitization — an authenticated client must not be able to store an oversized or
 * unsanitized field by skipping the import flow.
 */
export function sanitizeNoteFields(
	fields: { name: string; value: string }[]
): { name: string; value: string }[] {
	if (!Array.isArray(fields) || fields.length === 0) {
		throw error(400, 'Invalid note fields');
	}
	if (fields.length > IMPORT_LIMITS.maxFieldsPerNote) {
		throw error(413, 'Field limit exceeded');
	}

	return fields.map((field, index) => {
		const name = sanitizePlainText(field?.name ?? `Field ${index + 1}`, 1_000);
		const value = typeof field?.value === 'string' ? field.value : '';
		assertMaxBytes(value, IMPORT_LIMITS.maxFieldBytes, 'Card field');
		return {
			name: name || `Field ${index + 1}`,
			value: sanitizeCardHtml(value)
		};
	});
}

/** Cap and sanitize a note's tag string the same way the import path does. */
export function sanitizeNoteTags(tags: unknown): string {
	return sanitizePlainText(typeof tags === 'string' ? tags : '', IMPORT_LIMITS.maxTagsBytes);
}

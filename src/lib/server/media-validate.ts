/**
 * Verify that the media referenced by a note or deck (`<img src="...">` etc.) actually exists in
 * R2, so an agent migrating images can confirm nothing dangles. Read-only: scoped by user_id, and
 * only HEADs the user's own media namespace.
 */
import { extractMediaFilenames } from './media-store';

/** Max notes scanned by validate_deck_media in one call (keeps the R2 HEAD fan-out bounded). */
export const MAX_DECK_MEDIA_NOTES = 1_000;

/**
 * Media refs referenced by a note's stored `fields` JSON. The column is JSON, so the card HTML
 * lives inside string values (with escaped quotes) — parse it first and scan the field values, not
 * the raw JSON text.
 */
export function refsFromFieldsJson(fieldsJson: string): string[] {
	let values: string[] = [];
	try {
		const parsed = JSON.parse(fieldsJson) as unknown;
		if (Array.isArray(parsed)) {
			values = parsed.map((field) => String((field as { value?: unknown })?.value ?? ''));
		}
	} catch {
		values = [];
	}
	return extractMediaFilenames(values.join('\n'));
}

async function resolveRefs(
	bucket: R2Bucket,
	userId: string,
	filenames: string[]
): Promise<Map<string, boolean>> {
	const unique = [...new Set(filenames)];
	const present = await Promise.all(unique.map((name) => bucket.head(`${userId}/${name}`).then((o) => o !== null)));
	return new Map(unique.map((name, i) => [name, present[i]]));
}

export async function validateNoteMedia(
	db: D1Database,
	bucket: R2Bucket,
	userId: string,
	noteId: string
): Promise<{ note_id: string; total_refs: number; missing: string[]; ok: boolean }> {
	const note = await db
		.prepare('SELECT fields FROM notes WHERE id = ? AND user_id = ?')
		.bind(noteId, userId)
		.first<{ fields: string }>();
	if (!note) throw new Error('NOTE_NOT_FOUND');

	const refs = refsFromFieldsJson(note.fields);
	const resolved = await resolveRefs(bucket, userId, refs);
	const missing = [...resolved.entries()].filter(([, ok]) => !ok).map(([name]) => name);
	return { note_id: noteId, total_refs: resolved.size, missing, ok: missing.length === 0 };
}

export async function validateDeckMedia(
	db: D1Database,
	bucket: R2Bucket,
	userId: string,
	deckId: string
): Promise<{
	deck_id: string;
	notes_checked: number;
	notes_truncated: boolean;
	total_refs: number;
	missing: Array<{ note_id: string; filename: string }>;
	ok: boolean;
}> {
	const deck = await db
		.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?')
		.bind(deckId, userId)
		.first<{ id: string }>();
	if (!deck) throw new Error('DECK_NOT_FOUND');

	const notes = (
		await db
			.prepare('SELECT id, fields FROM notes WHERE deck_id = ? AND user_id = ? ORDER BY created_at, id LIMIT ?')
			.bind(deckId, userId, MAX_DECK_MEDIA_NOTES + 1)
			.all<{ id: string; fields: string }>()
	).results;
	const truncated = notes.length > MAX_DECK_MEDIA_NOTES;
	const page = truncated ? notes.slice(0, MAX_DECK_MEDIA_NOTES) : notes;

	// Collect every (note, filename) ref, resolve the distinct filenames once, then map back.
	const refsByNote = page.map((note) => ({ noteId: note.id, refs: refsFromFieldsJson(note.fields) }));
	const allFilenames = refsByNote.flatMap((entry) => entry.refs);
	const resolved = await resolveRefs(bucket, userId, allFilenames);

	const missing: Array<{ note_id: string; filename: string }> = [];
	let totalRefs = 0;
	for (const { noteId, refs } of refsByNote) {
		for (const filename of refs) {
			totalRefs++;
			if (!resolved.get(filename)) missing.push({ note_id: noteId, filename });
		}
	}

	return {
		deck_id: deckId,
		notes_checked: page.length,
		notes_truncated: truncated,
		total_refs: totalRefs,
		missing,
		ok: missing.length === 0
	};
}

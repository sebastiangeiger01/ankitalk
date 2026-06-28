/**
 * Mutating operations on existing decks, notes, and cards — the "edit & remove" half of the MCP
 * `cards:write` surface (read lives in study-context.ts, authoring in card-authoring.ts).
 *
 * Invariants shared with the rest of the app:
 *  - `decks.card_count` is a denormalized counter; every add/remove/move keeps it in lock-step.
 *  - `note_search_fts` is maintained by triggers on `notes` (migration 0016), so updating a note's
 *    fields/tags/deck_id keeps search in sync automatically — nothing here touches FTS directly.
 *  - New cards are queued by `due_at ASC` (there is no position column), so repositioning a
 *    still-new card means rewriting its `due_at`. Only `fsrs_state = 0` cards can be reordered.
 *  - A cloze note owns one card per distinct `{{cN::}}` ordinal; editing fields reconciles that set
 *    (adds cards for new deletions, removes cards for deletions that disappeared).
 *  - Every statement is scoped by `user_id` so one user can never touch another's rows.
 */

import { sanitizePlainText } from '$lib/sanitize';
import { newId } from '$lib/server/db';
import { validateCardDrafts, type CardDraft } from './card-authoring';

const MAX_DECK_NAME_BYTES = 200;
const MAX_DECK_DESCRIPTION_BYTES = 2_000;

/** Build `?,?,?` for an `IN (...)` clause of the given length. */
function placeholders(count: number): string {
	return new Array(count).fill('?').join(',');
}

export interface NoteField {
	name: string;
	value: string;
}

// ── Pure helpers (unit-tested without a database) ──────────────────────────────────────────────

/** Split a space-separated tag string into trimmed, non-empty tags. */
export function parseTags(tags: string): string[] {
	return tags.split(/\s+/).map((tag) => tag.trim()).filter(Boolean);
}

/** Serialize tags back to the space-separated form, de-duplicated and order-preserving. */
export function serializeTags(tags: Iterable<string>): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of tags) {
		const tag = raw.trim();
		if (tag && !seen.has(tag)) {
			seen.add(tag);
			out.push(tag);
		}
	}
	return out.join(' ');
}

/**
 * Apply tag edits to a note's current tag string. `set` replaces the whole list; `add`/`remove`
 * are then layered on top (so you can `set` and `add` in one call). Returns the new tag string.
 */
export function applyTagChanges(
	current: string,
	change: { set?: string[]; add?: string[]; remove?: string[] }
): string {
	let tags = change.set ? [...change.set] : parseTags(current);
	if (change.add) tags = [...tags, ...change.add];
	if (change.remove) {
		const removal = new Set(change.remove.map((tag) => tag.trim()).filter(Boolean));
		tags = tags.filter((tag) => !removal.has(tag.trim()));
	}
	return serializeTags(tags);
}

/** Which card ordinals to add / remove so a note's cards match its new set of cloze ordinals. */
export function reconcileOrdinals(
	existing: number[],
	next: number[]
): { toAdd: number[]; toRemove: number[] } {
	const existingSet = new Set(existing);
	const nextSet = new Set(next);
	return {
		toAdd: next.filter((ordinal) => !existingSet.has(ordinal)),
		toRemove: existing.filter((ordinal) => !nextSet.has(ordinal))
	};
}

/**
 * Assign strictly increasing `due_at` timestamps (1s apart) starting at `baseIso`, so a list of
 * new cards sorts in the requested order. Anchoring at the earliest existing due date keeps the
 * reordered cards in roughly their original position within the deck's new-card queue.
 */
export function reorderedDueAts(baseIso: string, count: number): string[] {
	const parsed = Date.parse(baseIso);
	const start = Number.isFinite(parsed) ? parsed : Date.now();
	return Array.from({ length: count }, (_, index) => new Date(start + index * 1000).toISOString());
}

// ── Deck edits ─────────────────────────────────────────────────────────────────────────────────

export async function updateDeck(
	db: D1Database,
	userId: string,
	input: { deckId: string; name?: string; description?: string }
): Promise<{ updated: boolean; deck: { deck_id: string; name: string; description: string } }> {
	const deck = await db
		.prepare('SELECT id, name, description FROM decks WHERE id = ? AND user_id = ?')
		.bind(input.deckId, userId)
		.first<{ id: string; name: string; description: string }>();
	if (!deck) throw new Error('DECK_NOT_FOUND');

	const sets: string[] = [];
	const binds: string[] = [];
	let name = deck.name;
	let description = deck.description;

	if (input.name !== undefined) {
		name = sanitizePlainText(input.name, MAX_DECK_NAME_BYTES).trim();
		if (!name) throw new Error('INVALID_DECK_NAME');
		sets.push('name = ?');
		binds.push(name);
	}
	if (input.description !== undefined) {
		description = sanitizePlainText(input.description, MAX_DECK_DESCRIPTION_BYTES);
		sets.push('description = ?');
		binds.push(description);
	}
	if (sets.length === 0) throw new Error('NO_FIELDS_TO_UPDATE');

	sets.push("updated_at = datetime('now')");
	await db
		.prepare(`UPDATE decks SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
		.bind(...binds, input.deckId, userId)
		.run();

	return { updated: true, deck: { deck_id: input.deckId, name, description } };
}

export async function deleteDeck(
	db: D1Database,
	userId: string,
	input: { deckId: string }
): Promise<{ deleted: boolean; cards_deleted: number }> {
	const deck = await db
		.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?')
		.bind(input.deckId, userId)
		.first<{ id: string }>();
	if (!deck) throw new Error('DECK_NOT_FOUND');

	const count = await db
		.prepare('SELECT COUNT(*) AS n FROM cards WHERE deck_id = ? AND user_id = ?')
		.bind(input.deckId, userId)
		.first<{ n: number }>();

	// Explicit cascade (reviews → cards → notes → deck), mirroring the web DELETE endpoint, so the
	// behaviour matches regardless of whether D1 enforces ON DELETE CASCADE for this connection.
	await db.batch([
		db.prepare('DELETE FROM reviews WHERE deck_id = ? AND user_id = ?').bind(input.deckId, userId),
		db.prepare('DELETE FROM cards WHERE deck_id = ? AND user_id = ?').bind(input.deckId, userId),
		db.prepare('DELETE FROM notes WHERE deck_id = ? AND user_id = ?').bind(input.deckId, userId),
		db.prepare('DELETE FROM decks WHERE id = ? AND user_id = ?').bind(input.deckId, userId)
	]);

	return { deleted: true, cards_deleted: count?.n ?? 0 };
}

// ── Note edits ─────────────────────────────────────────────────────────────────────────────────

export async function updateNoteFields(
	db: D1Database,
	userId: string,
	input: { noteId: string; fields: NoteField[] }
): Promise<{ updated: boolean; note_id?: string; cards_added?: number; cards_removed?: number; validation?: unknown[] }> {
	const note = await db
		.prepare('SELECT id, deck_id, model_name FROM notes WHERE id = ? AND user_id = ?')
		.bind(input.noteId, userId)
		.first<{ id: string; deck_id: string; model_name: string }>();
	if (!note) throw new Error('NOTE_NOT_FOUND');

	const cards = (
		await db
			.prepare('SELECT id, ordinal, card_type FROM cards WHERE note_id = ? AND user_id = ?')
			.bind(input.noteId, userId)
			.all<{ id: string; ordinal: number; card_type: string }>()
	).results;
	const cardType: 'basic' | 'cloze' = cards.some((card) => card.card_type === 'cloze') ? 'cloze' : 'basic';

	const draft: CardDraft = { fields: input.fields, card_type: cardType, model_name: note.model_name };
	const [validation] = validateCardDrafts([draft]);
	if (!validation.valid) return { updated: false, validation: [validation] };

	const nextOrdinals = validation.previews.map((preview) => preview.ordinal);
	const { toAdd, toRemove } = reconcileOrdinals(
		cards.map((card) => card.ordinal),
		nextOrdinals
	);
	const removeIds = cards.filter((card) => toRemove.includes(card.ordinal)).map((card) => card.id);

	const now = new Date().toISOString();
	const statements: D1PreparedStatement[] = [
		db
			.prepare('UPDATE notes SET fields = ? WHERE id = ? AND user_id = ?')
			.bind(JSON.stringify(input.fields), input.noteId, userId)
	];

	for (const ordinal of toAdd) {
		statements.push(
			db
				.prepare(
					`INSERT INTO cards
					 (id, user_id, deck_id, note_id, anki_id, ordinal, card_type, due_at,
					  fsrs_state, fsrs_stability, fsrs_difficulty, fsrs_elapsed_days,
					  fsrs_scheduled_days, fsrs_reps, fsrs_lapses, fsrs_last_review,
					  buried_until, suspended, created_at, updated_at)
					 VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, NULL, NULL, 0, ?, ?)`
				)
				.bind(newId(), userId, note.deck_id, input.noteId, ordinal, cardType, now, now, now)
		);
	}
	if (removeIds.length > 0) {
		const ph = placeholders(removeIds.length);
		statements.push(
			db.prepare(`DELETE FROM reviews WHERE user_id = ? AND card_id IN (${ph})`).bind(userId, ...removeIds),
			db.prepare(`DELETE FROM cards WHERE user_id = ? AND id IN (${ph})`).bind(userId, ...removeIds)
		);
	}
	const delta = toAdd.length - removeIds.length;
	if (delta !== 0) {
		statements.push(
			db
				.prepare(
					"UPDATE decks SET card_count = MAX(card_count + ?, 0), updated_at = datetime('now') WHERE id = ? AND user_id = ?"
				)
				.bind(delta, note.deck_id, userId)
		);
	}

	await db.batch(statements);
	return { updated: true, note_id: input.noteId, cards_added: toAdd.length, cards_removed: removeIds.length };
}

export async function updateNoteTags(
	db: D1Database,
	userId: string,
	input: { noteId: string; set?: string[]; add?: string[]; remove?: string[] }
): Promise<{ updated: boolean; note_id: string; tags: string[] }> {
	if (input.set === undefined && input.add === undefined && input.remove === undefined) {
		throw new Error('NO_TAG_CHANGES');
	}
	const note = await db
		.prepare('SELECT id, tags FROM notes WHERE id = ? AND user_id = ?')
		.bind(input.noteId, userId)
		.first<{ id: string; tags: string }>();
	if (!note) throw new Error('NOTE_NOT_FOUND');

	const tags = applyTagChanges(note.tags, { set: input.set, add: input.add, remove: input.remove });
	await db
		.prepare('UPDATE notes SET tags = ? WHERE id = ? AND user_id = ?')
		.bind(tags, input.noteId, userId)
		.run();

	return { updated: true, note_id: input.noteId, tags: parseTags(tags) };
}

export async function moveNotesToDeck(
	db: D1Database,
	userId: string,
	input: { noteIds: string[]; targetDeckId: string }
): Promise<{ moved: boolean; notes_moved: number; cards_moved: number }> {
	const target = await db
		.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?')
		.bind(input.targetDeckId, userId)
		.first<{ id: string }>();
	if (!target) throw new Error('TARGET_DECK_NOT_FOUND');

	const ph = placeholders(input.noteIds.length);
	const notes = (
		await db
			.prepare(`SELECT id, deck_id FROM notes WHERE user_id = ? AND id IN (${ph})`)
			.bind(userId, ...input.noteIds)
			.all<{ id: string; deck_id: string }>()
	).results;
	// Only move notes that aren't already in the target deck.
	const moving = notes.filter((note) => note.deck_id !== input.targetDeckId).map((note) => note.id);
	if (moving.length === 0) return { moved: false, notes_moved: 0, cards_moved: 0 };

	const movingPh = placeholders(moving.length);
	const sourceCounts = (
		await db
			.prepare(
				`SELECT deck_id, COUNT(*) AS n FROM cards WHERE user_id = ? AND note_id IN (${movingPh}) GROUP BY deck_id`
			)
			.bind(userId, ...moving)
			.all<{ deck_id: string; n: number }>()
	).results;
	const totalCards = sourceCounts.reduce((sum, row) => sum + row.n, 0);

	const statements: D1PreparedStatement[] = [
		db
			.prepare(`UPDATE notes SET deck_id = ? WHERE user_id = ? AND id IN (${movingPh})`)
			.bind(input.targetDeckId, userId, ...moving),
		db
			.prepare(
				`UPDATE cards SET deck_id = ?, updated_at = datetime('now') WHERE user_id = ? AND note_id IN (${movingPh})`
			)
			.bind(input.targetDeckId, userId, ...moving)
	];
	for (const row of sourceCounts) {
		statements.push(
			db
				.prepare(
					"UPDATE decks SET card_count = MAX(card_count - ?, 0), updated_at = datetime('now') WHERE id = ? AND user_id = ?"
				)
				.bind(row.n, row.deck_id, userId)
		);
	}
	statements.push(
		db
			.prepare(
				"UPDATE decks SET card_count = card_count + ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
			)
			.bind(totalCards, input.targetDeckId, userId)
	);

	await db.batch(statements);
	return { moved: true, notes_moved: moving.length, cards_moved: totalCards };
}

export async function deleteNotes(
	db: D1Database,
	userId: string,
	input: { noteIds: string[] }
): Promise<{ deleted: boolean; notes_deleted: number; cards_deleted: number }> {
	const ph = placeholders(input.noteIds.length);
	const notes = (
		await db
			.prepare(`SELECT id, deck_id FROM notes WHERE user_id = ? AND id IN (${ph})`)
			.bind(userId, ...input.noteIds)
			.all<{ id: string; deck_id: string }>()
	).results;
	if (notes.length === 0) return { deleted: false, notes_deleted: 0, cards_deleted: 0 };

	const foundIds = notes.map((note) => note.id);
	const foundPh = placeholders(foundIds.length);
	const cardCounts = (
		await db
			.prepare(
				`SELECT deck_id, COUNT(*) AS n FROM cards WHERE user_id = ? AND note_id IN (${foundPh}) GROUP BY deck_id`
			)
			.bind(userId, ...foundIds)
			.all<{ deck_id: string; n: number }>()
	).results;
	const totalCards = cardCounts.reduce((sum, row) => sum + row.n, 0);

	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`DELETE FROM reviews WHERE user_id = ? AND card_id IN (SELECT id FROM cards WHERE user_id = ? AND note_id IN (${foundPh}))`
			)
			.bind(userId, userId, ...foundIds),
		db.prepare(`DELETE FROM cards WHERE user_id = ? AND note_id IN (${foundPh})`).bind(userId, ...foundIds),
		db.prepare(`DELETE FROM notes WHERE user_id = ? AND id IN (${foundPh})`).bind(userId, ...foundIds)
	];
	for (const row of cardCounts) {
		statements.push(
			db
				.prepare(
					"UPDATE decks SET card_count = MAX(card_count - ?, 0), updated_at = datetime('now') WHERE id = ? AND user_id = ?"
				)
				.bind(row.n, row.deck_id, userId)
		);
	}

	await db.batch(statements);
	return { deleted: true, notes_deleted: foundIds.length, cards_deleted: totalCards };
}

// ── Card edits ─────────────────────────────────────────────────────────────────────────────────

export async function setCardsSuspended(
	db: D1Database,
	userId: string,
	input: { cardIds: string[]; suspended: boolean }
): Promise<{ suspended: boolean; matched: number }> {
	const ph = placeholders(input.cardIds.length);
	// Resolve which requested cards the user actually owns so the count we report is accurate.
	const owned = (
		await db
			.prepare(`SELECT id FROM cards WHERE user_id = ? AND id IN (${ph})`)
			.bind(userId, ...input.cardIds)
			.all<{ id: string }>()
	).results.map((row) => row.id);
	if (owned.length === 0) return { suspended: input.suspended, matched: 0 };

	const ownedPh = placeholders(owned.length);
	await db
		.prepare(
			`UPDATE cards SET suspended = ?, updated_at = datetime('now') WHERE user_id = ? AND id IN (${ownedPh})`
		)
		.bind(input.suspended ? 1 : 0, userId, ...owned)
		.run();

	return { suspended: input.suspended, matched: owned.length };
}

export async function reorderNewCards(
	db: D1Database,
	userId: string,
	input: { deckId: string; orderedCardIds: string[] }
): Promise<{ reordered: number }> {
	const deck = await db
		.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?')
		.bind(input.deckId, userId)
		.first<{ id: string }>();
	if (!deck) throw new Error('DECK_NOT_FOUND');

	const ph = placeholders(input.orderedCardIds.length);
	const rows = (
		await db
			.prepare(`SELECT id, fsrs_state, due_at FROM cards WHERE user_id = ? AND deck_id = ? AND id IN (${ph})`)
			.bind(userId, input.deckId, ...input.orderedCardIds)
			.all<{ id: string; fsrs_state: number; due_at: string }>()
	).results;

	if (rows.length !== input.orderedCardIds.length) throw new Error('CARD_NOT_FOUND_IN_DECK');
	if (rows.some((row) => row.fsrs_state !== 0)) throw new Error('CARD_NOT_NEW');

	// Anchor at the earliest existing due date so the reordered cards keep their place in the queue.
	const base = rows.reduce(
		(earliest, row) => (Date.parse(row.due_at) < Date.parse(earliest) ? row.due_at : earliest),
		rows[0].due_at
	);
	const dueAts = reorderedDueAts(base, input.orderedCardIds.length);

	const statements = input.orderedCardIds.map((cardId, index) =>
		db
			.prepare("UPDATE cards SET due_at = ?, updated_at = datetime('now') WHERE user_id = ? AND id = ?")
			.bind(dueAts[index], userId, cardId)
	);
	await db.batch(statements);
	return { reordered: input.orderedCardIds.length };
}

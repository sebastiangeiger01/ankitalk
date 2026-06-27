import { renderCard } from '$lib/client/card-renderer';
import { serverCardSanitizer } from './card-sanitize';
import { sanitizePlainText } from '$lib/sanitize';
import { newId } from '$lib/server/db';

export interface CardDraft {
	fields: Array<{ name: string; value: string }>;
	tags?: string[];
	card_type?: 'basic' | 'cloze';
	model_name?: string;
}

interface ValidatedDraft {
	draft_index: number;
	valid: boolean;
	errors: string[];
	previews: Array<{ ordinal: number; question: string; answer: string }>;
}

const MAX_CLOZE_CARDS_PER_NOTE = 20;
const MAX_CARDS_PER_REQUEST = 50;
const MAX_DECKS_PER_USER = 1_000;
const MAX_DECK_NAME_BYTES = 200;
const MAX_DECK_DESCRIPTION_BYTES = 2_000;

function clozeOrdinals(fields: CardDraft['fields']): number[] {
	const values = fields.map((field) => field.value).join('\n');
	const ordinals = new Set<number>();
	for (const match of values.matchAll(/\{\{c(\d+)::/gi)) {
		const number = Number(match[1]);
		if (Number.isInteger(number) && number >= 1 && number <= 100) ordinals.add(number - 1);
	}
	return [...ordinals].sort((a, b) => a - b);
}

function ordinalsForDraft(draft: CardDraft): number[] {
	if (draft.card_type !== 'cloze') return [0];
	return clozeOrdinals(draft.fields);
}

export function validateCardDrafts(drafts: CardDraft[]): ValidatedDraft[] {
	return drafts.map((draft, draftIndex) => {
		const errors: string[] = [];
		if (draft.fields.length === 0) errors.push('At least one field is required.');
		const names = new Set<string>();
		for (const field of draft.fields) {
			const name = field.name.trim();
			if (!name) errors.push('Every field needs a name.');
			if (names.has(name.toLowerCase())) errors.push(`Duplicate field name: ${name}`);
			names.add(name.toLowerCase());
		}
		if (!draft.fields.some((field) => field.value.trim())) {
			errors.push('At least one field needs content.');
		}
		const ordinals = ordinalsForDraft(draft);
		if (draft.card_type === 'cloze' && ordinals.length === 0) {
			errors.push('Cloze notes need at least one {{c1::answer}} deletion.');
		}
		if (ordinals.length > MAX_CLOZE_CARDS_PER_NOTE) {
			errors.push(`A note can create at most ${MAX_CLOZE_CARDS_PER_NOTE} cloze cards.`);
		}
		const fieldsJson = JSON.stringify(draft.fields);
		const previews = ordinals.map((ordinal) => {
			const rendered = renderCard(fieldsJson, draft.card_type ?? 'basic', ordinal, null, null, serverCardSanitizer);
			return { ordinal, question: rendered.front, answer: rendered.back };
		});
		return { draft_index: draftIndex, valid: errors.length === 0, errors, previews };
	});
}

export async function createNotes(
	db: D1Database,
	userId: string,
	input: { deckId: string; drafts: CardDraft[]; idempotencyKey: string }
) {
	const previous = await db
		.prepare(
			`SELECT result_json
			 FROM mcp_idempotency_keys
			 WHERE user_id = ? AND tool_name = 'create_notes' AND idempotency_key = ?`
		)
		.bind(userId, input.idempotencyKey)
		.first<{ result_json: string }>();
	if (previous) return JSON.parse(previous.result_json) as unknown;

	const deck = await db
		.prepare('SELECT id, name FROM decks WHERE id = ? AND user_id = ?')
		.bind(input.deckId, userId)
		.first<{ id: string; name: string }>();
	if (!deck) throw new Error('DECK_NOT_FOUND');

	const validation = validateCardDrafts(input.drafts);
	const requestedCardCount = validation.reduce((total, draft) => total + draft.previews.length, 0);
	if (requestedCardCount > MAX_CARDS_PER_REQUEST) {
		validation[0]?.errors.push(`One request can create at most ${MAX_CARDS_PER_REQUEST} cards.`);
		if (validation[0]) validation[0].valid = false;
	}
	if (validation.some((draft) => !draft.valid)) {
		return { created: false, validation };
	}

	const statements: D1PreparedStatement[] = [];
	const created: Array<{ note_id: string; card_ids: string[] }> = [];
	const now = new Date().toISOString();
	let cardCount = 0;
	for (const draft of input.drafts) {
		const noteId = newId();
		const ordinals = ordinalsForDraft(draft);
		const tags = (draft.tags ?? []).map((tag) => tag.trim()).filter(Boolean).join(' ');
		statements.push(
			db
				.prepare(
					`INSERT INTO notes
					 (id, user_id, deck_id, anki_id, model_name, fields, tags, created_at)
					 VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
				)
				.bind(
					noteId,
					userId,
					input.deckId,
					draft.model_name ?? (draft.card_type === 'cloze' ? 'Cloze' : 'Basic'),
					JSON.stringify(draft.fields),
					tags,
					now
				)
		);
		const cardIds: string[] = [];
		for (const ordinal of ordinals) {
			const cardId = newId();
			cardIds.push(cardId);
			cardCount++;
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
					.bind(
						cardId,
						userId,
						input.deckId,
						noteId,
						ordinal,
						draft.card_type ?? 'basic',
						now,
						now,
						now
					)
			);
		}
		created.push({ note_id: noteId, card_ids: cardIds });
	}
	statements.push(
		db
			.prepare(
				`UPDATE decks
				 SET card_count = card_count + ?, updated_at = datetime('now')
				 WHERE id = ? AND user_id = ?`
			)
			.bind(cardCount, input.deckId, userId)
	);
	const result = { created: true, deck_id: input.deckId, notes: created, card_count: cardCount };
	statements.push(
		db
			.prepare(
				`INSERT INTO mcp_idempotency_keys
				 (user_id, tool_name, idempotency_key, result_json)
				 VALUES (?, 'create_notes', ?, ?)`
			)
			.bind(userId, input.idempotencyKey, JSON.stringify(result))
	);

	try {
		await db.batch(statements);
		return result;
	} catch (error) {
		// A concurrent retry can win the unique idempotency-key insert. Return the
		// committed result instead of duplicating notes.
		const raced = await db
			.prepare(
				`SELECT result_json
				 FROM mcp_idempotency_keys
				 WHERE user_id = ? AND tool_name = 'create_notes' AND idempotency_key = ?`
			)
			.bind(userId, input.idempotencyKey)
			.first<{ result_json: string }>();
		if (raced) return JSON.parse(raced.result_json) as unknown;
		throw error;
	}
}

export interface CreateDeckResult {
	created: boolean;
	/** True when an existing same-named deck was returned instead of creating a duplicate. */
	existing: boolean;
	deck: { deck_id: string; name: string; description: string; card_count: number };
}

/**
 * Create a deck for the user, or return the existing one if a deck with the same name already
 * exists (case-insensitive). Mirrors createNotes: an idempotency key replays the exact prior
 * result, name/description are sanitized as plain text, a per-user cap bounds runaway agents,
 * and a lost insert race falls back to the committed result.
 *
 * Name dedup is best-effort via a lookup (there is no unique constraint — historical imports
 * permit duplicate deck names), so a rare concurrent double-create with the same name can still
 * produce two decks. NOCASE folds only ASCII case, which is sufficient for typical deck names.
 */
export async function createDeck(
	db: D1Database,
	userId: string,
	input: { name: string; description?: string; idempotencyKey: string }
): Promise<CreateDeckResult> {
	const previous = await db
		.prepare(
			`SELECT result_json
			 FROM mcp_idempotency_keys
			 WHERE user_id = ? AND tool_name = 'create_deck' AND idempotency_key = ?`
		)
		.bind(userId, input.idempotencyKey)
		.first<{ result_json: string }>();
	if (previous) return JSON.parse(previous.result_json) as CreateDeckResult;

	const name = sanitizePlainText(input.name, MAX_DECK_NAME_BYTES).trim();
	if (!name) throw new Error('INVALID_DECK_NAME');
	const description = sanitizePlainText(input.description ?? '', MAX_DECK_DESCRIPTION_BYTES);

	const existing = await db
		.prepare(
			`SELECT id AS deck_id, name, description, card_count
			 FROM decks
			 WHERE user_id = ? AND name = ? COLLATE NOCASE
			 ORDER BY created_at, id
			 LIMIT 1`
		)
		.bind(userId, name)
		.first<{ deck_id: string; name: string; description: string; card_count: number }>();
	if (existing) {
		return { created: false, existing: true, deck: existing };
	}

	const count = await db
		.prepare('SELECT COUNT(*) AS n FROM decks WHERE user_id = ?')
		.bind(userId)
		.first<{ n: number }>();
	if ((count?.n ?? 0) >= MAX_DECKS_PER_USER) throw new Error('DECK_LIMIT_REACHED');

	const id = newId();
	const result: CreateDeckResult = {
		created: true,
		existing: false,
		deck: { deck_id: id, name, description, card_count: 0 }
	};
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`INSERT INTO decks (id, user_id, anki_id, name, description, card_count)
				 VALUES (?, ?, NULL, ?, ?, 0)`
			)
			.bind(id, userId, name, description),
		db
			.prepare(
				`INSERT INTO mcp_idempotency_keys
				 (user_id, tool_name, idempotency_key, result_json)
				 VALUES (?, 'create_deck', ?, ?)`
			)
			.bind(userId, input.idempotencyKey, JSON.stringify(result))
	];

	try {
		await db.batch(statements);
		return result;
	} catch (error) {
		// A concurrent retry can win the unique idempotency-key insert. Return the committed
		// result instead of duplicating the deck.
		const raced = await db
			.prepare(
				`SELECT result_json
				 FROM mcp_idempotency_keys
				 WHERE user_id = ? AND tool_name = 'create_deck' AND idempotency_key = ?`
			)
			.bind(userId, input.idempotencyKey)
			.first<{ result_json: string }>();
		if (raced) return JSON.parse(raced.result_json) as CreateDeckResult;
		throw error;
	}
}

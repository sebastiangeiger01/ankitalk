import { renderCard } from '$lib/client/card-renderer';
import { serverCardSanitizer } from './card-sanitize';

const MAX_TEXT_CHARS = 2_000;
const MAX_CONTEXT_FIELDS = 20;
const MAX_CURSOR_OFFSET = 500;

export type CardState = 'new' | 'learning' | 'review' | 'relearning' | 'unknown';

export interface RenderedStudyCard {
	card_id: string;
	note_id: string;
	deck_id: string;
	deck_name: string;
	question: string;
	answer: string;
	fields: Array<{ name: string; value: string }>;
	tags: string[];
	state: CardState;
	due_at: string | null;
	reps: number;
	lapses: number;
	stability: number;
	difficulty: number;
	suspended: boolean;
}

interface CardRow {
	card_id: string;
	note_id: string;
	deck_id: string;
	deck_name: string;
	card_type: string;
	ordinal: number;
	front_template: string | null;
	back_template: string | null;
	fields: string;
	tags: string;
	fsrs_state: number;
	due_at: string | null;
	fsrs_reps: number;
	fsrs_lapses: number;
	fsrs_stability: number;
	fsrs_difficulty: number;
	suspended: number;
}

function stateLabel(value: number): CardState {
	switch (value) {
		case 0:
			return 'new';
		case 1:
			return 'learning';
		case 2:
			return 'review';
		case 3:
			return 'relearning';
		default:
			return 'unknown';
	}
}

function parseFields(value: string): Array<{ name: string; value: string }> {
	try {
		const fields = JSON.parse(value) as unknown;
		if (!Array.isArray(fields)) return [];
		return fields
			.filter((field): field is { name?: unknown; value?: unknown } => !!field && typeof field === 'object')
			.slice(0, MAX_CONTEXT_FIELDS)
			.map((field) => ({
				name: String(field.name ?? '').slice(0, 200),
				value: String(field.value ?? '').slice(0, MAX_TEXT_CHARS)
			}));
	} catch {
		return [];
	}
}

function compactStudyCard(row: CardRow): Omit<RenderedStudyCard, 'fields'> {
	const { fields: _fields, ...card } = renderStudyCard(row);
	return card;
}

function parseTags(value: string): string[] {
	return value
		.split(/\s+/)
		.map((tag) => tag.trim())
		.filter(Boolean)
		.slice(0, 100);
}

export function renderStudyCard(row: CardRow): RenderedStudyCard {
	const rendered = renderCard(
		row.fields,
		row.card_type,
		row.ordinal,
		row.front_template,
		row.back_template,
		serverCardSanitizer
	);
	return {
		card_id: row.card_id,
		note_id: row.note_id,
		deck_id: row.deck_id,
		deck_name: row.deck_name,
		question: rendered.front.slice(0, MAX_TEXT_CHARS),
		answer: rendered.back.slice(0, MAX_TEXT_CHARS),
		fields: parseFields(row.fields),
		tags: parseTags(row.tags),
		state: stateLabel(row.fsrs_state),
		due_at: row.due_at,
		reps: row.fsrs_reps,
		lapses: row.fsrs_lapses,
		stability: row.fsrs_stability,
		difficulty: row.fsrs_difficulty,
		suspended: row.suspended === 1
	};
}

const CARD_SELECT = `
	c.id AS card_id,
	c.note_id,
	c.deck_id,
	d.name AS deck_name,
	c.card_type,
	c.ordinal,
	c.front_template,
	c.back_template,
	n.fields,
	n.tags,
	c.fsrs_state,
	c.due_at,
	c.fsrs_reps,
	c.fsrs_lapses,
	c.fsrs_stability,
	c.fsrs_difficulty,
	c.suspended`;

export async function getCardContext(db: D1Database, userId: string, cardId: string) {
	const row = await db
		.prepare(
			`SELECT ${CARD_SELECT}
			 FROM cards c
			 JOIN notes n ON n.id = c.note_id AND n.user_id = c.user_id
			 JOIN decks d ON d.id = c.deck_id AND d.user_id = c.user_id
			 WHERE c.id = ? AND c.user_id = ?`
		)
		.bind(cardId, userId)
		.first<CardRow>();
	if (!row) return null;

	const [reviews, siblingRows] = await Promise.all([
		db
			.prepare(
				`SELECT rating, created_at, duration_ms
				 FROM reviews
				 WHERE card_id = ? AND user_id = ?
				 ORDER BY created_at DESC, id DESC
				 LIMIT 10`
			)
			.bind(cardId, userId)
			.all<{ rating: string; created_at: string; duration_ms: number | null }>(),
		db
			.prepare(
				`SELECT ${CARD_SELECT}
				 FROM cards c
				 JOIN notes n ON n.id = c.note_id AND n.user_id = c.user_id
				 JOIN decks d ON d.id = c.deck_id AND d.user_id = c.user_id
				 WHERE c.note_id = ? AND c.user_id = ? AND c.id != ?
				 ORDER BY c.ordinal, c.id
				 LIMIT 10`
			)
			.bind(row.note_id, userId, cardId)
			.all<CardRow>()
	]);

	return {
		card: renderStudyCard(row),
		recent_reviews: reviews.results,
		sibling_cards: siblingRows.results.map(renderStudyCard)
	};
}

export function buildFtsQuery(query: string): string | null {
	const terms = query
		.normalize('NFKC')
		.match(/[\p{L}\p{N}]+/gu)
		?.filter((term) => term.length > 0)
		.slice(0, 12);
	if (!terms?.length) return null;
	return terms
		.map((term) => `"${term.replaceAll('"', '""')}"${term.length >= 3 ? '*' : ''}`)
		.join(' AND ');
}

function encodeCursor(offset: number): string {
	return btoa(JSON.stringify({ v: 1, o: offset }))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/g, '');
}

function decodeCursor(cursor?: string): number {
	if (!cursor) return 0;
	try {
		const padded = cursor.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(cursor.length / 4) * 4, '=');
		const parsed = JSON.parse(atob(padded)) as { v?: unknown; o?: unknown };
		if (parsed.v !== 1 || !Number.isInteger(parsed.o)) return 0;
		return Math.max(0, Math.min(MAX_CURSOR_OFFSET, Number(parsed.o)));
	} catch {
		return 0;
	}
}

export async function searchStudyMaterial(
	db: D1Database,
	userId: string,
	input: { query: string; deckId?: string; limit: number; cursor?: string }
) {
	const ftsQuery = buildFtsQuery(input.query);
	if (!ftsQuery) return { cards: [], next_cursor: null, query: input.query };
	const offset = decodeCursor(input.cursor);
	const params: Array<string | number> = [ftsQuery, userId];
	let deckClause = '';
	if (input.deckId) {
		deckClause = ' AND c.deck_id = ?';
		params.push(input.deckId);
	}
	params.push(input.limit + 1, offset);
	const result = await db
		.prepare(
			`SELECT ${CARD_SELECT},
				bm25(note_search_fts, 0.0, 0.0, 0.0, 5.0, 2.5, 1.0) AS relevance
			 FROM note_search_fts
			 JOIN notes n ON n.rowid = note_search_fts.rowid
			 JOIN cards c ON c.note_id = n.id AND c.user_id = n.user_id
			 JOIN decks d ON d.id = c.deck_id AND d.user_id = c.user_id
			 WHERE note_search_fts MATCH ?
			   AND note_search_fts.user_id = ?${deckClause}
			 ORDER BY relevance ASC, c.id ASC
			 LIMIT ? OFFSET ?`
		)
		.bind(...params)
		.all<CardRow & { relevance: number }>();
	const hasMore = result.results.length > input.limit;
	const cards = result.results.slice(0, input.limit).map((row) => ({
		...compactStudyCard(row),
		relevance: row.relevance
	}));
	return {
		cards,
		next_cursor: hasMore ? encodeCursor(offset + input.limit) : null,
		query: input.query
	};
}

export interface DeckSummary {
	deck_id: string;
	name: string;
	description: string;
	card_count: number;
}

/**
 * List the user's decks (name, description, card count) so an agent can pick an existing
 * target before authoring — or confirm one doesn't exist yet before creating it. Paginated
 * with the same opaque cursor as the card readers. Ordered case-insensitively by name so the
 * listing is stable and human-readable.
 */
export async function listDecks(
	db: D1Database,
	userId: string,
	input: { limit: number; cursor?: string }
) {
	const offset = decodeCursor(input.cursor);
	const result = await db
		.prepare(
			`SELECT id AS deck_id, name, description, card_count
			 FROM decks
			 WHERE user_id = ?
			 ORDER BY name COLLATE NOCASE, id
			 LIMIT ? OFFSET ?`
		)
		.bind(userId, input.limit + 1, offset)
		.all<DeckSummary>();
	const hasMore = result.results.length > input.limit;
	return {
		decks: result.results.slice(0, input.limit),
		next_cursor: hasMore ? encodeCursor(offset + input.limit) : null
	};
}

/**
 * List the notes in one deck with their fields, tags, and per-note cards (id, ordinal, state) so an
 * agent can drive systematic bulk edits from stable IDs. Paginated with the same opaque cursor as
 * the card readers; ordered by creation so the listing is stable across pages.
 */
export async function listNotes(
	db: D1Database,
	userId: string,
	input: { deckId: string; limit: number; cursor?: string }
) {
	const deck = await db
		.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?')
		.bind(input.deckId, userId)
		.first<{ id: string }>();
	if (!deck) throw new Error('DECK_NOT_FOUND');

	const offset = decodeCursor(input.cursor);
	const noteRows = (
		await db
			.prepare(
				`SELECT id, model_name, fields, tags
				 FROM notes
				 WHERE deck_id = ? AND user_id = ?
				 ORDER BY created_at, id
				 LIMIT ? OFFSET ?`
			)
			.bind(input.deckId, userId, input.limit + 1, offset)
			.all<{ id: string; model_name: string; fields: string; tags: string }>()
	).results;

	const hasMore = noteRows.length > input.limit;
	const page = hasMore ? noteRows.slice(0, input.limit) : noteRows;

	const cardsByNote = new Map<string, Array<{ card_id: string; ordinal: number; state: CardState; suspended: boolean }>>();
	if (page.length > 0) {
		const ph = page.map(() => '?').join(',');
		const cardRows = (
			await db
				.prepare(
					`SELECT id, note_id, ordinal, fsrs_state, suspended
					 FROM cards
					 WHERE user_id = ? AND note_id IN (${ph})
					 ORDER BY ordinal, id`
				)
				.bind(userId, ...page.map((note) => note.id))
				.all<{ id: string; note_id: string; ordinal: number; fsrs_state: number; suspended: number }>()
		).results;
		for (const card of cardRows) {
			const list = cardsByNote.get(card.note_id) ?? [];
			list.push({ card_id: card.id, ordinal: card.ordinal, state: stateLabel(card.fsrs_state), suspended: card.suspended === 1 });
			cardsByNote.set(card.note_id, list);
		}
	}

	return {
		deck_id: input.deckId,
		notes: page.map((note) => ({
			note_id: note.id,
			model_name: note.model_name,
			fields: parseFields(note.fields),
			tags: parseTags(note.tags),
			cards: cardsByNote.get(note.id) ?? []
		})),
		next_cursor: hasMore ? encodeCursor(offset + input.limit) : null
	};
}

export type CardFinderStatus = 'due' | 'struggling' | 'leech' | 'new' | 'suspended';

export async function findCards(
	db: D1Database,
	userId: string,
	input: { status: CardFinderStatus; deckId?: string; limit: number; cursor?: string }
) {
	const offset = decodeCursor(input.cursor);
	const statusSql: Record<CardFinderStatus, string> = {
		due: "c.due_at <= datetime('now') AND c.suspended = 0",
		struggling: 'c.fsrs_lapses > 0 AND c.suspended = 0',
		leech: 'c.fsrs_lapses >= 3',
		new: 'c.fsrs_state = 0 AND c.suspended = 0',
		suspended: 'c.suspended = 1'
	};
	const params: Array<string | number> = [userId];
	let deckClause = '';
	if (input.deckId) {
		deckClause = ' AND c.deck_id = ?';
		params.push(input.deckId);
	}
	params.push(input.limit + 1, offset);
	const result = await db
		.prepare(
			`SELECT ${CARD_SELECT}
			 FROM cards c
			 JOIN notes n ON n.id = c.note_id AND n.user_id = c.user_id
			 JOIN decks d ON d.id = c.deck_id AND d.user_id = c.user_id
			 WHERE c.user_id = ? AND ${statusSql[input.status]}${deckClause}
			 ORDER BY c.fsrs_lapses DESC, c.due_at ASC, c.id ASC
			 LIMIT ? OFFSET ?`
		)
		.bind(...params)
		.all<CardRow>();
	const hasMore = result.results.length > input.limit;
	return {
		cards: result.results.slice(0, input.limit).map(compactStudyCard),
		next_cursor: hasMore ? encodeCursor(offset + input.limit) : null,
		status: input.status
	};
}

export async function getStudyProgress(
	db: D1Database,
	userId: string,
	input: { deckId?: string; days: number }
) {
	const cardBinds: Array<string> = [userId];
	const reviewBinds: Array<string | number> = [userId, input.days];
	let deckClause = '';
	if (input.deckId) {
		deckClause = ' AND deck_id = ?';
		cardBinds.push(input.deckId);
		reviewBinds.push(input.deckId);
	}
	const deckBinds: string[] = [userId];
	let selectedDeckClause = '';
	if (input.deckId) {
		selectedDeckClause = ' AND d.id = ?';
		deckBinds.push(input.deckId);
	}
	const [cards, reviews, decks] = await Promise.all([
		db
			.prepare(
				`SELECT
					COUNT(*) AS total,
					SUM(CASE WHEN due_at <= datetime('now') AND suspended = 0 THEN 1 ELSE 0 END) AS due,
					SUM(CASE WHEN fsrs_state = 0 AND suspended = 0 THEN 1 ELSE 0 END) AS new_count,
					SUM(CASE WHEN fsrs_state IN (1, 3) AND suspended = 0 THEN 1 ELSE 0 END) AS learning,
					SUM(CASE WHEN fsrs_state = 2 AND suspended = 0 THEN 1 ELSE 0 END) AS review,
					SUM(CASE WHEN suspended = 1 THEN 1 ELSE 0 END) AS suspended
				 FROM cards
				 WHERE user_id = ?${deckClause}`
			)
			.bind(...cardBinds)
			.first<Record<string, number | null>>(),
		db
			.prepare(
				`SELECT
					COUNT(*) AS total,
					SUM(CASE WHEN rating != 'again' THEN 1 ELSE 0 END) AS passed,
					SUM(CASE WHEN rating = 'again' THEN 1 ELSE 0 END) AS again_count,
					SUM(CASE WHEN rating = 'hard' THEN 1 ELSE 0 END) AS hard_count,
					SUM(CASE WHEN rating = 'good' THEN 1 ELSE 0 END) AS good_count,
					SUM(CASE WHEN rating = 'easy' THEN 1 ELSE 0 END) AS easy_count,
					AVG(duration_ms) AS average_duration_ms
				 FROM reviews
				 WHERE user_id = ?
				   AND created_at >= datetime('now', '-' || ? || ' days')${deckClause}`
			)
			.bind(...reviewBinds)
			.first<Record<string, number | null>>(),
		db
			.prepare(
				`SELECT
					d.id AS deck_id,
					d.name,
					COUNT(c.id) AS card_count,
					SUM(CASE WHEN c.due_at <= datetime('now') AND c.suspended = 0 THEN 1 ELSE 0 END) AS due_count,
					SUM(CASE WHEN c.fsrs_lapses > 0 AND c.suspended = 0 THEN 1 ELSE 0 END) AS struggling_count
				 FROM decks d
				 LEFT JOIN cards c ON c.deck_id = d.id AND c.user_id = d.user_id
				 WHERE d.user_id = ?${selectedDeckClause}
				 GROUP BY d.id, d.name
				 ORDER BY d.name, d.id`
			)
			.bind(...deckBinds)
			.all<{
				deck_id: string;
				name: string;
				card_count: number;
				due_count: number;
				struggling_count: number;
			}>()
	]);
	const totalReviews = reviews?.total ?? 0;
	return {
		period_days: input.days,
		deck_id: input.deckId ?? null,
		decks: decks.results,
		cards: {
			total: cards?.total ?? 0,
			due: cards?.due ?? 0,
			new: cards?.new_count ?? 0,
			learning: cards?.learning ?? 0,
			review: cards?.review ?? 0,
			suspended: cards?.suspended ?? 0
		},
		reviews: {
			total: totalReviews,
			retention_rate: totalReviews > 0 ? (reviews?.passed ?? 0) / totalReviews : null,
			again: reviews?.again_count ?? 0,
			hard: reviews?.hard_count ?? 0,
			good: reviews?.good_count ?? 0,
			easy: reviews?.easy_count ?? 0,
			average_duration_ms: reviews?.average_duration_ms ?? null
		}
	};
}

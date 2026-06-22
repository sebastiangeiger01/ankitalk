import type { ToolResult } from './protocol';
import { textResult, errorResult } from './protocol';
import { explainCard } from '$lib/server/explain';
import { getUserApiKey } from '$lib/server/user-keys';

/**
 * MCP tool registry. Each tool declares an LLM-facing description + a JSON-Schema
 * inputSchema, plus a handler that runs against the user's D1 / environment.
 *
 * Tool design notes:
 *  - Keep results small. The agent reads everything we return back as LLM context — a
 *    100-card response would eat a chunk of the model's window.
 *  - Return clean prose in `content[].text` (what the LLM consumes) AND a JSON mirror in
 *    `structuredContent` (what schema-aware clients prefer).
 *  - User scoping is implicit: every query filters by `user_id` taken from the bearer
 *    token, so the agent can't reach data from other users even if it tries.
 *
 * The surface is broader than the current Lernen flow needs because the user wants the
 * same MCP server to underpin future LLM-powered features (card creation, study reports).
 * Adding a new tool is a single entry here — no client changes required.
 */

export interface ToolContext {
	db: D1Database;
	userId: string;
	encryptionKey: string;
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Strip Anki-specific HTML/cloze markup so the agent sees clean prose. */
function plain(s: string | null | undefined, max = 2000): string {
	if (!s) return '';
	return s
		.replace(/<[^>]+>/g, ' ')
		.replace(/\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g, (_m, content, _hint) => content)
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, max);
}

interface NoteFieldsRow {
	card_id: string;
	deck_id: string;
	deck_name: string;
	fields: string;
	tags: string | null;
	fsrs_state: number | null;
	fsrs_lapses: number | null;
	fsrs_reps: number | null;
}

/** Anki note fields are stored as JSON `[{name, value}, ...]`. Return as front/back. */
function frontBack(fieldsJson: string): { front: string; back: string } {
	try {
		const arr = JSON.parse(fieldsJson) as Array<{ name?: string; value?: string }>;
		if (!Array.isArray(arr) || arr.length === 0) return { front: '', back: '' };
		const front = plain(arr[0]?.value ?? '');
		const back = arr
			.slice(1)
			.map((f) => plain(f?.value ?? ''))
			.filter(Boolean)
			.join(' — ');
		return { front, back };
	} catch {
		return { front: '', back: '' };
	}
}

function stateLabel(n: number | null | undefined): string {
	switch (n) {
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

// search_cards ----------------------------------------------------------------
const searchCards: ToolDefinition = {
	name: 'search_cards',
	description:
		'Search the user\'s Anki cards by free-text query. Matches against the note fields (front + back content) and tags. Returns up to `limit` cards (default 5, max 20).',
	inputSchema: {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Text to search for in card content and tags.' },
			deck_id: {
				type: 'string',
				description: 'Optional deck id to scope the search to a single deck.'
			},
			limit: {
				type: 'integer',
				description: 'Maximum number of cards to return (default 5, max 20).',
				minimum: 1,
				maximum: 20
			}
		},
		required: ['query']
	},
	async handler(args, { db, userId }) {
		const query = typeof args.query === 'string' ? args.query.trim() : '';
		if (!query) return errorResult('query is required');
		const deckId = typeof args.deck_id === 'string' ? args.deck_id : null;
		const limitRaw = typeof args.limit === 'number' ? args.limit : 5;
		const limit = Math.max(1, Math.min(20, Math.floor(limitRaw)));
		// SQLite LIKE with %escape% is good enough for small per-user data sets; D1 doesn't
		// have FTS5 by default and adding it for a single MCP tool would be over-engineering.
		const like = `%${query.replace(/[%_]/g, (m) => '\\' + m)}%`;
		const params: unknown[] = [userId, like, like];
		let sql =
			`SELECT c.id AS card_id, c.deck_id, d.name AS deck_name, n.fields, n.tags,
				c.fsrs_state, c.fsrs_lapses, c.fsrs_reps
			 FROM cards c
			 JOIN notes n ON n.id = c.note_id
			 JOIN decks d ON d.id = c.deck_id
			 WHERE c.user_id = ?
			   AND (n.fields LIKE ? ESCAPE '\\' OR n.tags LIKE ? ESCAPE '\\')`;
		if (deckId) {
			sql += ' AND c.deck_id = ?';
			params.push(deckId);
		}
		sql += ' ORDER BY c.fsrs_reps DESC LIMIT ?';
		params.push(limit);
		const res = await db
			.prepare(sql)
			.bind(...params)
			.all<NoteFieldsRow>();
		const cards = res.results.map((row) => {
			const fb = frontBack(row.fields);
			return {
				card_id: row.card_id,
				deck_id: row.deck_id,
				deck_name: row.deck_name,
				front: fb.front,
				back: fb.back,
				tags: row.tags ?? '',
				state: stateLabel(row.fsrs_state)
			};
		});
		if (cards.length === 0) return textResult(`No cards matched "${query}".`, { cards: [] });
		const text = cards
			.map((c, i) => `${i + 1}. [${c.deck_name}] ${c.front} → ${c.back}${c.tags ? ` #${c.tags}` : ''}`)
			.join('\n');
		return textResult(text, { cards });
	}
};

// list_decks ------------------------------------------------------------------
const listDecks: ToolDefinition = {
	name: 'list_decks',
	description: 'List all decks the user owns, with their card counts. Useful when the user references a deck by name.',
	inputSchema: { type: 'object', properties: {} },
	async handler(_args, { db, userId }) {
		const res = await db
			.prepare(
				`SELECT d.id AS deck_id, d.name, COUNT(c.id) AS card_count
				 FROM decks d
				 LEFT JOIN cards c ON c.deck_id = d.id AND c.user_id = d.user_id
				 WHERE d.user_id = ?
				 GROUP BY d.id, d.name
				 ORDER BY d.name`
			)
			.bind(userId)
			.all<{ deck_id: string; name: string; card_count: number }>();
		if (res.results.length === 0) return textResult('No decks yet.', { decks: [] });
		const text = res.results.map((d) => `- ${d.name} (${d.card_count} cards) [${d.deck_id}]`).join('\n');
		return textResult(text, { decks: res.results });
	}
};

// get_card --------------------------------------------------------------------
const getCard: ToolDefinition = {
	name: 'get_card',
	description: 'Fetch one card by id with its content, tags, and current scheduling state.',
	inputSchema: {
		type: 'object',
		properties: { card_id: { type: 'string', description: 'The card id.' } },
		required: ['card_id']
	},
	async handler(args, { db, userId }) {
		const cardId = typeof args.card_id === 'string' ? args.card_id : '';
		if (!cardId) return errorResult('card_id is required');
		const row = await db
			.prepare(
				`SELECT c.id AS card_id, c.deck_id, d.name AS deck_name, n.fields, n.tags,
					c.fsrs_state, c.fsrs_stability, c.fsrs_lapses, c.fsrs_reps, c.fsrs_last_review, c.due_at
				 FROM cards c
				 JOIN notes n ON n.id = c.note_id
				 JOIN decks d ON d.id = c.deck_id
				 WHERE c.id = ? AND c.user_id = ?`
			)
			.bind(cardId, userId)
			.first<NoteFieldsRow & { fsrs_stability: number | null; fsrs_last_review: string | null; due_at: string | null }>();
		if (!row) return errorResult('Card not found.');
		const fb = frontBack(row.fields);
		const card = {
			card_id: row.card_id,
			deck_id: row.deck_id,
			deck_name: row.deck_name,
			front: fb.front,
			back: fb.back,
			tags: row.tags ?? '',
			state: stateLabel(row.fsrs_state),
			lapses: row.fsrs_lapses ?? 0,
			reps: row.fsrs_reps ?? 0,
			last_review: row.fsrs_last_review,
			due_at: row.due_at
		};
		const text = `[${card.deck_name}] ${card.front} → ${card.back}\nState: ${card.state}, reps ${card.reps}, lapses ${card.lapses}${card.tags ? `, tags ${card.tags}` : ''}`;
		return textResult(text, { card });
	}
};

// get_card_history ------------------------------------------------------------
const getCardHistory: ToolDefinition = {
	name: 'get_card_history',
	description: 'Recent review ratings for a card, newest first. Useful for understanding how the user has struggled (or not) with this card.',
	inputSchema: {
		type: 'object',
		properties: {
			card_id: { type: 'string' },
			limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10, max 50.' }
		},
		required: ['card_id']
	},
	async handler(args, { db, userId }) {
		const cardId = typeof args.card_id === 'string' ? args.card_id : '';
		if (!cardId) return errorResult('card_id is required');
		const limit = Math.max(1, Math.min(50, Math.floor(typeof args.limit === 'number' ? args.limit : 10)));
		const res = await db
			.prepare(
				`SELECT rating, created_at, duration_ms
				 FROM reviews
				 WHERE card_id = ? AND user_id = ?
				 ORDER BY created_at DESC
				 LIMIT ?`
			)
			.bind(cardId, userId, limit)
			.all<{ rating: string; created_at: string; duration_ms: number | null }>();
		if (res.results.length === 0) return textResult('No reviews yet for this card.', { reviews: [] });
		const text = res.results
			.map((r) => `- ${r.created_at} → ${r.rating}${r.duration_ms ? ` (${(r.duration_ms / 1000).toFixed(1)}s)` : ''}`)
			.join('\n');
		return textResult(text, { reviews: res.results });
	}
};

// explain_topic ---------------------------------------------------------------
const explainTopic: ToolDefinition = {
	name: 'explain_topic',
	description:
		'Get a concise AI-generated explanation of a topic, scoped to the user\'s deck context. Uses the user\'s Anthropic API key if configured; returns an error otherwise.',
	inputSchema: {
		type: 'object',
		properties: {
			topic: { type: 'string', description: 'The topic to explain.' },
			context: { type: 'string', description: 'Optional context the explanation should build on (e.g. a card the user is studying).' }
		},
		required: ['topic']
	},
	async handler(args, { db, userId, encryptionKey }) {
		const topic = typeof args.topic === 'string' ? args.topic.trim() : '';
		if (!topic) return errorResult('topic is required');
		const context = typeof args.context === 'string' ? args.context.trim() : '';
		const anthropicKey = await getUserApiKey(db, userId, 'anthropic', encryptionKey);
		if (!anthropicKey) {
			return errorResult('No Anthropic API key configured for this user; explain_topic is unavailable.');
		}
		// Reuse the same explain pipeline used by /api/explain so the tutor explanation
		// matches the rest of the app. Front = topic, back = optional context.
		const { explanation } = await explainCard(anthropicKey, topic, context || topic);
		return textResult(explanation, { topic, explanation });
	}
};

export const TOOLS: ToolDefinition[] = [searchCards, listDecks, getCard, getCardHistory, explainTopic];

export function findTool(name: string): ToolDefinition | undefined {
	return TOOLS.find((t) => t.name === name);
}

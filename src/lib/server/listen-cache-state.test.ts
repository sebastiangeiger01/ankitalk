import { describe, expect, it } from 'vitest';
import { loadDocumentCacheState } from './listen-cache-state';
import type { ListenDocumentRow } from './listen';

const doc = {
	id: 'doc1',
	user_id: 'u1',
	voice_id: 'voice',
	tts_model: 'eleven_flash_v2_5',
	language: 'de',
	title: 'Doc'
} as ListenDocumentRow;

/**
 * D1 fake that answers each prepared statement from a queue of result sets, and records the
 * SQL it was asked for.
 */
function makeDb(results: unknown[][]) {
	const queries: string[] = [];
	const db = {
		queries,
		prepare(sql: string) {
			queries.push(sql.replace(/\s+/g, ' ').trim());
			return {
				bind: () => ({
					all: async () => ({ results: results.shift() ?? [] })
				})
			};
		}
	};
	return db as unknown as D1Database & { queries: string[] };
}

describe('loadDocumentCacheState at the canonical speed', () => {
	it('splits cached from pending using the joined r2_key', async () => {
		const db = makeDb([
			[
				{ seq: 0, text: 'One.', char_count: 4, sentence_hash: 'h0', r2_key: 'k0' },
				{ seq: 1, text: 'Two.', char_count: 4, sentence_hash: 'h1', r2_key: null },
				{ seq: 2, text: 'Three.', char_count: 6, sentence_hash: 'h2', r2_key: 'k2' }
			]
		]);

		const state = await loadDocumentCacheState(db, 'u1', doc, 1);

		expect(state.sentences).toHaveLength(3);
		expect(state.cachedCount).toBe(2);
		expect(state.pending.map((s) => s.seq)).toEqual([1]);
		expect(state.sentences[0].r2Key).toBe('k0');
		expect(state.sentences[0].cacheHash).toBe('h0');
	});

	it('resolves the whole document in a single query, not one per sentence', async () => {
		const rows = Array.from({ length: 200 }, (_, i) => ({
			seq: i,
			text: `S${i}.`,
			char_count: 4,
			sentence_hash: `h${i}`,
			r2_key: null
		}));
		const db = makeDb([rows]);

		const state = await loadDocumentCacheState(db, 'u1', doc, 1);

		expect(state.pending).toHaveLength(200);
		expect(db.queries).toHaveLength(1);
	});

	it('treats an expired cache row as pending', async () => {
		// The SQL nulls r2_key when expires_at has passed, so an expired row arrives as null.
		const db = makeDb([
			[{ seq: 0, text: 'One.', char_count: 4, sentence_hash: 'h0', r2_key: null }]
		]);

		const state = await loadDocumentCacheState(db, 'u1', doc, 1);

		expect(state.cachedCount).toBe(0);
		expect(state.pending).toHaveLength(1);
	});
});

describe('loadDocumentCacheState at a non-default speed', () => {
	it('matches against speed-specific hashes rather than the stored ones', async () => {
		const { hashSentence } = await import('$lib/listen/sentences');
		const fastHash = await hashSentence('One.', 'voice', 'eleven_flash_v2_5', 'de', 1.2);

		const db = makeDb([
			[
				{ seq: 0, text: 'One.', char_count: 4, sentence_hash: 'stored-h0' },
				{ seq: 1, text: 'Two.', char_count: 4, sentence_hash: 'stored-h1' }
			],
			// Only the 1.2× lane entry for the first sentence exists.
			[{ sentence_hash: fastHash, r2_key: 'fast-k0' }]
		]);

		const state = await loadDocumentCacheState(db, 'u1', doc, 1.2);

		expect(state.sentences[0].cacheHash).toBe(fastHash);
		expect(state.sentences[0].r2Key).toBe('fast-k0');
		// The stored 1.0× hash must not count as a hit for this lane.
		expect(state.sentences[1].r2Key).toBeNull();
		expect(state.pending.map((s) => s.seq)).toEqual([1]);
	});

	it('stays at a fixed number of queries regardless of document length', async () => {
		const rows = Array.from({ length: 50 }, (_, i) => ({
			seq: i,
			text: `S${i}.`,
			char_count: 4,
			sentence_hash: `h${i}`
		}));
		const db = makeDb([rows, []]);

		await loadDocumentCacheState(db, 'u1', doc, 0.7);

		expect(db.queries).toHaveLength(2);
	});
});

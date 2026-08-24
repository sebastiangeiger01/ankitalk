import { hashSentence } from '$lib/listen/sentences';
import type { ListenDocumentRow } from './listen';

/**
 * Which of a document's sentences already have cached audio, at a given generation speed.
 *
 * Both the download and the generate endpoint need this, and both need it to agree exactly:
 * the download refuses to start unless every sentence is cached, and the generate endpoint is
 * what makes that true. A single source of truth keeps them from disagreeing about what
 * "complete" means and leaving the UI stuck in a loop that can never finish.
 */

export interface CachedSentence {
	seq: number;
	text: string;
	char_count: number;
	/** Cache key for this sentence at the requested speed. */
	cacheHash: string;
	/** R2 object holding the audio, or null when it still has to be synthesized. */
	r2Key: string | null;
}

export interface DocumentCacheState {
	sentences: CachedSentence[];
	pending: CachedSentence[];
	cachedCount: number;
}

interface JoinedRow {
	seq: number;
	text: string;
	char_count: number;
	sentence_hash: string;
	r2_key: string | null;
}

interface PlainRow {
	seq: number;
	text: string;
	char_count: number;
	sentence_hash: string;
}

/**
 * Resolve every sentence plus its cache state in a fixed number of queries — never one per
 * sentence. A long document has thousands of them, and a per-sentence lookup would spend the
 * invocation's whole subrequest budget on bookkeeping before reading a single byte of audio.
 */
export async function loadDocumentCacheState(
	db: D1Database,
	userId: string,
	doc: ListenDocumentRow,
	genSpeed: number
): Promise<DocumentCacheState> {
	let sentences: CachedSentence[];

	if (genSpeed === 1) {
		// The canonical lane: `listen_sentences.sentence_hash` is already the cache key, so one
		// join answers the whole question.
		const rows = await db
			.prepare(
				`SELECT s.seq, s.text, s.char_count, s.sentence_hash,
					CASE WHEN c.expires_at > datetime('now') THEN c.r2_key ELSE NULL END AS r2_key
				 FROM listen_sentences s
				 LEFT JOIN listen_sentence_cache c
					ON c.user_id = ? AND c.sentence_hash = s.sentence_hash
				 WHERE s.doc_id = ?
				 ORDER BY s.seq`
			)
			.bind(userId, doc.id)
			.all<JoinedRow>();

		sentences = rows.results.map((row) => ({
			seq: row.seq,
			text: row.text,
			char_count: row.char_count,
			cacheHash: row.sentence_hash,
			r2Key: row.r2_key
		}));
	} else {
		// A non-default speed hashes into its own cache lane, which SQL can't compute — so hash
		// in memory and reconcile against the user's cache rows with one more query.
		const rows = await db
			.prepare(
				'SELECT seq, text, char_count, sentence_hash FROM listen_sentences WHERE doc_id = ? ORDER BY seq'
			)
			.bind(doc.id)
			.all<PlainRow>();

		const hashes = await Promise.all(
			rows.results.map((r) =>
				hashSentence(r.text, doc.voice_id, doc.tts_model, doc.language ?? '', genSpeed)
			)
		);

		const cacheRows = await db
			.prepare(
				"SELECT sentence_hash, r2_key FROM listen_sentence_cache WHERE user_id = ? AND expires_at > datetime('now')"
			)
			.bind(userId)
			.all<{ sentence_hash: string; r2_key: string }>();
		const cached = new Map(cacheRows.results.map((r) => [r.sentence_hash, r.r2_key]));

		sentences = rows.results.map((row, i) => ({
			seq: row.seq,
			text: row.text,
			char_count: row.char_count,
			cacheHash: hashes[i],
			r2Key: cached.get(hashes[i]) ?? null
		}));
	}

	const pending = sentences.filter((s) => s.r2Key === null);
	return { sentences, pending, cachedCount: sentences.length - pending.length };
}

import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { estimateDurationMsFromChars, hashSentence } from '$lib/listen/sentences';
import type { ListenDocumentRow } from '$lib/server/listen';
import type { ListenSentenceInfo, ListenSentencesResponse } from '$lib/listen/types';
import type { RequestHandler } from './$types';

interface SentenceRow {
	seq: number;
	text: string;
	char_count: number;
	sentence_hash: string;
	cached_duration_ms: number | null;
}

interface PlainRow {
	seq: number;
	text: string;
	char_count: number;
	sentence_hash: string;
}

const MIN_GEN_SPEED = 0.7;
const MAX_GEN_SPEED = 1.2;

function clampSpeed(raw: string | null): number {
	const n = raw === null ? 1 : Number(raw);
	if (!Number.isFinite(n)) return 1;
	return Math.max(MIN_GEN_SPEED, Math.min(MAX_GEN_SPEED, n));
}

export const GET: RequestHandler = async ({ params, url, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const doc = await db
		.prepare(
			"SELECT * FROM listen_documents WHERE id = ? AND user_id = ? AND expires_at > datetime('now')"
		)
		.bind(params.id, locals.userId)
		.first<ListenDocumentRow>();
	if (!doc) throw error(404, 'Not found');
	if (doc.original_text === null) throw error(409, 'Legacy document');

	// At the canonical 1.0× generation speed the cache key is `listen_sentences.sentence_hash`
	// directly (set at doc creation), so we LEFT JOIN once and return the existing cached
	// state — this is the fast path and the one almost every request hits.
	//
	// At any other speed the cache key incorporates that speed, so we hash each sentence
	// freshly and reconcile against the user's cache rows in memory. Two queries instead of
	// one, but only when the user is exercising a non-default speed (where cache hits are
	// rarer anyway). The hash set membership avoids an `IN (?,?,...)` of potentially
	// thousands of params hitting SQLite's host-parameter ceiling.
	const genSpeed = clampSpeed(url.searchParams.get('speed'));

	let sentences: ListenSentenceInfo[];
	let cachedCount = 0;

	if (genSpeed === 1) {
		const sentencesRes = await db
			.prepare(
				`SELECT s.seq, s.text, s.char_count, s.sentence_hash,
					CASE WHEN c.expires_at > datetime('now') THEN c.duration_ms ELSE NULL END AS cached_duration_ms
				 FROM listen_sentences s
				 LEFT JOIN listen_sentence_cache c
					ON c.user_id = ? AND c.sentence_hash = s.sentence_hash
				 WHERE s.doc_id = ?
				 ORDER BY s.seq`
			)
			.bind(locals.userId, params.id)
			.all<SentenceRow>();

		sentences = sentencesRes.results.map((row) => {
			const cached = row.cached_duration_ms !== null;
			if (cached) cachedCount++;
			return {
				seq: row.seq,
				text: row.text,
				char_count: row.char_count,
				sentence_hash: row.sentence_hash,
				cached,
				duration_ms: cached ? row.cached_duration_ms! : estimateDurationMsFromChars(row.char_count)
			};
		});
	} else {
		const rowsRes = await db
			.prepare('SELECT seq, text, char_count, sentence_hash FROM listen_sentences WHERE doc_id = ? ORDER BY seq')
			.bind(params.id)
			.all<PlainRow>();

		const speedHashes = await Promise.all(
			rowsRes.results.map((r) => hashSentence(r.text, doc.voice_id, doc.tts_model, doc.language ?? '', genSpeed))
		);

		const cacheRes = await db
			.prepare(
				"SELECT sentence_hash, duration_ms FROM listen_sentence_cache WHERE user_id = ? AND expires_at > datetime('now')"
			)
			.bind(locals.userId)
			.all<{ sentence_hash: string; duration_ms: number }>();
		const cacheMap = new Map(cacheRes.results.map((r) => [r.sentence_hash, r.duration_ms]));

		sentences = rowsRes.results.map((row, i) => {
			const h = speedHashes[i];
			const dur = cacheMap.get(h);
			const cached = dur !== undefined;
			if (cached) cachedCount++;
			return {
				seq: row.seq,
				text: row.text,
				char_count: row.char_count,
				// Return the speed-aware hash so the client's bookkeeping stays consistent with
				// what the stream endpoint will actually look up.
				sentence_hash: h,
				cached,
				duration_ms: cached ? dur : estimateDurationMsFromChars(row.char_count)
			};
		});
	}

	const body: ListenSentencesResponse = {
		document: {
			id: doc.id,
			title: doc.title,
			voice_id: doc.voice_id,
			tts_model: doc.tts_model,
			language: doc.language,
			total_chars: doc.total_chars,
			sentence_count: sentences.length,
			created_at: doc.created_at,
			expires_at: doc.expires_at
		},
		sentences,
		cached_count: cachedCount
	};
	return json(body);
};

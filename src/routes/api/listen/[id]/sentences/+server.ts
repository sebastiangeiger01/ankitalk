import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { estimateDurationMsFromChars } from '$lib/listen/sentences';
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

export const GET: RequestHandler = async ({ params, platform, locals }) => {
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

	// Left join the cache for this user — `cached_duration_ms` is non-null iff the audio is
	// currently warm (the join is keyed by user_id + sentence_hash, so other users' caches
	// can't leak through).
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

	let cachedCount = 0;
	const sentences: ListenSentenceInfo[] = sentencesRes.results.map((row) => {
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

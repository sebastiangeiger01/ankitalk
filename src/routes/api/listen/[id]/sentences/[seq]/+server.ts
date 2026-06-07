import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { hashSentence } from '$lib/listen/sentences';
import type { ListenDocumentRow } from '$lib/server/listen';
import type { RequestHandler } from './$types';

const MAX_SENTENCE_CHARS = 4500;

/**
 * Edit one sentence inside a document. The new text gets re-hashed (text + voice + model +
 * language) — so if the new content already lives in the user's cache from a different
 * document, regenerating it is free. If not, the next playback will pay only for this one
 * sentence rather than the whole document.
 */
export const PATCH: RequestHandler = async ({ params, request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const body = (await request.json().catch(() => ({}))) as { text?: unknown };
	const text = typeof body.text === 'string' ? body.text.trim() : '';
	if (!text) throw error(400, 'Missing text');
	if (text.length > MAX_SENTENCE_CHARS) throw error(413, 'Sentence too long');

	const seq = Number(params.seq);
	if (!Number.isInteger(seq) || seq < 0) throw error(400, 'Invalid seq');

	const db = getDb(platform!);
	const doc = await db
		.prepare(
			"SELECT * FROM listen_documents WHERE id = ? AND user_id = ? AND expires_at > datetime('now')"
		)
		.bind(params.id, locals.userId)
		.first<ListenDocumentRow>();
	if (!doc) throw error(404, 'Not found');
	if (doc.original_text === null) throw error(409, 'Legacy document');

	const newHash = await hashSentence(text, doc.voice_id, doc.tts_model, doc.language ?? '');
	const charCount = text.length;

	const updateRes = await db
		.prepare(
			"UPDATE listen_sentences SET text = ?, char_count = ?, sentence_hash = ? WHERE doc_id = ? AND seq = ?"
		)
		.bind(text, charCount, newHash, params.id, seq)
		.run();
	if (!updateRes.meta.changes) throw error(404, 'Sentence not found');

	const totals = await db
		.prepare('SELECT COALESCE(SUM(char_count), 0) AS total FROM listen_sentences WHERE doc_id = ?')
		.bind(params.id)
		.first<{ total: number }>();
	const newTotal = Number(totals?.total ?? 0);
	await db
		.prepare("UPDATE listen_documents SET total_chars = ?, updated_at = datetime('now') WHERE id = ?")
		.bind(newTotal, params.id)
		.run();

	return json({
		seq,
		text,
		char_count: charCount,
		sentence_hash: newHash,
		total_chars: newTotal
	});
};

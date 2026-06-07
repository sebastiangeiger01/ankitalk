import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { ListenDocumentRow } from '$lib/server/listen';
import type { RequestHandler } from './$types';

async function getOwnedDocument(
	db: D1Database,
	userId: string,
	id: string
): Promise<ListenDocumentRow | null> {
	return db
		.prepare(
			"SELECT * FROM listen_documents WHERE id = ? AND user_id = ? AND expires_at > datetime('now') AND original_text IS NOT NULL"
		)
		.bind(id, userId)
		.first<ListenDocumentRow>();
}

export const GET: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const doc = await getOwnedDocument(db, locals.userId, params.id);
	if (!doc) throw error(404, 'Not found');

	const cachedRow = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM listen_sentence_cache c
			 JOIN listen_sentences s ON s.sentence_hash = c.sentence_hash
			 WHERE c.user_id = ? AND s.doc_id = ? AND c.expires_at > datetime('now')`
		)
		.bind(locals.userId, params.id)
		.first<{ n: number }>();
	const cachedCount = Number(cachedRow?.n ?? 0);

	return json({
		document: {
			id: doc.id,
			title: doc.title,
			status: doc.status,
			total_chars: doc.total_chars,
			segment_count: doc.segment_count,
			cached_count: cachedCount,
			tts_model: doc.tts_model,
			voice_id: doc.voice_id,
			language: doc.language,
			estimated_credits: doc.estimated_credits,
			estimated_cost_usd: doc.estimated_cost_usd,
			created_at: doc.created_at,
			expires_at: doc.expires_at
		}
	});
};

export const PATCH: RequestHandler = async ({ params, request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const body = (await request.json()) as { title?: unknown };
	const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
	if (!title) throw error(400, 'Missing title');

	const db = getDb(platform!);
	const res = await db
		.prepare("UPDATE listen_documents SET title = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
		.bind(title, params.id, locals.userId)
		.run();

	if (!res.meta.changes) throw error(404, 'Not found');
	return json({ ok: true, title });
};

export const DELETE: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const doc = await db
		.prepare('SELECT id FROM listen_documents WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first<{ id: string }>();
	if (!doc) throw error(404, 'Not found');

	// Best-effort cleanup of any legacy per-segment R2 objects. Reader-model audio lives in
	// the shared sentence cache and isn't deleted here — it may still be used by other docs
	// and expires on its own R2 lifecycle.
	const segs = await db
		.prepare('SELECT r2_key FROM listen_segments WHERE document_id = ? AND r2_key IS NOT NULL')
		.bind(params.id)
		.all<{ r2_key: string }>();
	await Promise.allSettled(segs.results.map((s) => platform!.env.MEDIA.delete(s.r2_key)));

	await db.prepare('DELETE FROM listen_documents WHERE id = ? AND user_id = ?').bind(params.id, locals.userId).run();
	return json({ ok: true });
};

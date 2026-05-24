import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { ListenDocumentRow } from '$lib/server/listen';
import type { ListenSegmentInfo } from '$lib/listen/types';
import type { RequestHandler } from './$types';

async function getOwnedDocument(
	db: D1Database,
	userId: string,
	id: string
): Promise<ListenDocumentRow | null> {
	return db
		.prepare("SELECT * FROM listen_documents WHERE id = ? AND user_id = ? AND expires_at > datetime('now')")
		.bind(id, userId)
		.first<ListenDocumentRow>();
}

export const GET: RequestHandler = async ({ params, url, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const doc = await getOwnedDocument(db, locals.userId, params.id);
	if (!doc) throw error(404, 'Not found');

	const includeText = url.searchParams.get('text') === '1';
	const columns = includeText ? 'seq, status, char_count, source_text' : 'seq, status, char_count';
	const segs = await db
		.prepare(`SELECT ${columns} FROM listen_segments WHERE document_id = ? ORDER BY seq`)
		.bind(params.id)
		.all<ListenSegmentInfo>();

	const doneCount = segs.results.filter((s) => s.status === 'done').length;

	return json({
		document: {
			id: doc.id,
			title: doc.title,
			status: doc.status,
			total_chars: doc.total_chars,
			segment_count: doc.segment_count,
			done_count: doneCount,
			tts_model: doc.tts_model,
			voice_id: doc.voice_id,
			estimated_credits: doc.estimated_credits,
			estimated_cost_usd: doc.estimated_cost_usd,
			created_at: doc.created_at,
			expires_at: doc.expires_at
		},
		segments: segs.results
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

	const segs = await db
		.prepare('SELECT r2_key FROM listen_segments WHERE document_id = ? AND r2_key IS NOT NULL')
		.bind(params.id)
		.all<{ r2_key: string }>();
	await Promise.allSettled(segs.results.map((s) => platform!.env.MEDIA.delete(s.r2_key)));

	await db.prepare('DELETE FROM listen_documents WHERE id = ? AND user_id = ?').bind(params.id, locals.userId).run();
	return json({ ok: true });
};

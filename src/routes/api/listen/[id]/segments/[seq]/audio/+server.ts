import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const seq = Number(params.seq);
	if (!Number.isInteger(seq) || seq < 0) throw error(400, 'Invalid segment');

	const db = getDb(platform!);
	const row = await db
		.prepare(
			`SELECT s.r2_key FROM listen_segments s
			 JOIN listen_documents d ON d.id = s.document_id
			 WHERE s.document_id = ? AND s.seq = ? AND s.user_id = ? AND s.status = 'done'
			   AND d.expires_at > datetime('now')`
		)
		.bind(params.id, seq, locals.userId)
		.first<{ r2_key: string | null }>();

	if (!row?.r2_key) throw error(404, 'Audio not found');

	const object = await platform!.env.MEDIA.get(row.r2_key);
	if (!object) throw error(404, 'Audio not found');

	return new Response(object.body, {
		headers: {
			'Content-Type': 'audio/mpeg',
			'Cache-Control': 'private, max-age=3600',
			'X-Content-Type-Options': 'nosniff',
			'Cross-Origin-Resource-Policy': 'same-origin'
		}
	});
};

import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const body = (await request.json()) as { suspended: boolean };
	const suspended = body.suspended ? 1 : 0;

	const db = getDb(platform!);

	const card = await db
		.prepare('SELECT id FROM cards WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first();

	if (!card) throw error(404, 'Card not found');

	await db
		.prepare("UPDATE cards SET suspended = ?, updated_at = datetime('now') WHERE id = ?")
		.bind(suspended, params.id)
		.run();

	return json({ suspended });
};

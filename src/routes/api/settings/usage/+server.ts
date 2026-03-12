import { error, json } from '@sveltejs/kit';
import { getUsageSummary } from '$lib/server/usage';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const summary = await getUsageSummary(db, locals.userId);

	return json(summary);
};

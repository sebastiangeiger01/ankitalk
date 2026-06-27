import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getTtsCacheStats } from '$lib/server/tts-store';
import type { RequestHandler } from './$types';

/** How much voice audio this user currently has cached (durable R2 layer), for the settings page. */
export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');
	const db = getDb(platform!);
	return json(await getTtsCacheStats(db, locals.userId));
};

import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getCacheEventStats, getTtsCacheStats } from '$lib/server/tts-store';
import type { RequestHandler } from './$types';

/**
 * Voice-audio cache info for the settings page: how much is cached durably (R2), plus a monitor
 * of recent cache hit/miss outcomes and how many characters caching saved from the provider.
 */
export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');
	const db = getDb(platform!);
	const [storage, events] = await Promise.all([
		getTtsCacheStats(db, locals.userId),
		getCacheEventStats(db, locals.userId)
	]);
	return json({ ...storage, events });
};

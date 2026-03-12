import { json, error } from '@sveltejs/kit';
import { getUserApiKey } from '$lib/server/user-keys';
import { logUsage, calculateSttCost } from '$lib/server/usage';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	const db = getDb(platform!);

	const apiKey = await getUserApiKey(db, userId, 'deepgram', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) return json({ error: 'Add your Deepgram API key in Settings to use voice input' }, { status: 400 });

	const usagePromise = logUsage(db, userId, 'deepgram', 'stt_token', 60, calculateSttCost(60));
	platform?.context?.waitUntil(usagePromise);

	return json({ token: apiKey });
};

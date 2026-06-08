import { json, error } from '@sveltejs/kit';
import { getUserApiKey } from '$lib/server/user-keys';
import { logUsage, calculateSttCost } from '$lib/server/usage';
import { getDb } from '$lib/server/db';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/rate-limit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	const db = getDb(platform!);

	await enforceRateLimit(platform!.env.KV, userId, 'stt_token', RATE_LIMITS.stt_token_per_minute.limit, RATE_LIMITS.stt_token_per_minute.windowSec);

	const apiKey = await getUserApiKey(db, userId, 'deepgram', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) return json({ error: 'Add your Deepgram API key in Settings to use voice input' }, { status: 400 });

	// Request a short-lived token from Deepgram (requires Member-level key)
	const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
		method: 'POST',
		headers: {
			Authorization: `Token ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ time_to_live_in_seconds: 60 })
	});

	if (!response.ok) {
		// Log only the status server-side — never stringify the response body, which could
		// contain Deepgram credentials on a success branch (defense against a future bug
		// that moves this log outside the !ok guard) and would leak Deepgram-internal
		// detail to our logs regardless.
		console.error('Deepgram token error: status', response.status);
		throw error(502, 'Failed to get Deepgram token');
	}

	const data = (await response.json()) as { access_token?: string; key?: string };

	const usagePromise = logUsage(db, userId, 'deepgram', 'stt_token', 60, calculateSttCost(60));
	platform?.context?.waitUntil(usagePromise);

	return json({ token: data.access_token ?? data.key });
};

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

	// Request a short-lived token from Deepgram (requires Member-level key)
	const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
		method: 'POST',
		headers: {
			Authorization: `Token ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ time_to_live_in_seconds: 60 })
	});

	const data = (await response.json()) as { access_token?: string; key?: string; err_code?: string; err_msg?: string };

	if (!response.ok) {
		console.error('Deepgram token error:', response.status, JSON.stringify(data));
		throw error(502, `Failed to get Deepgram token: ${data.err_msg ?? response.statusText}`);
	}

	const usagePromise = logUsage(db, userId, 'deepgram', 'stt_token', 60, calculateSttCost(60));
	platform?.context?.waitUntil(usagePromise);

	return json({ token: data.access_token ?? data.key });
};

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const apiKey = platform?.env.DEEPGRAM_API_KEY;
	if (!apiKey) throw error(500, 'Deepgram API key not configured');

	// Request a short-lived token from Deepgram
	const response = await fetch('https://api.deepgram.com/v1/auth/grant', {
		method: 'POST',
		headers: {
			Authorization: `Token ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			time_to_live_in_seconds: 60
		})
	});

	const data = (await response.json()) as { access_token?: string; key?: string; err_code?: string; err_msg?: string };

	if (!response.ok) {
		console.error('Deepgram token error:', response.status, JSON.stringify(data));
		throw error(502, `Failed to get Deepgram token: ${data.err_msg ?? response.statusText}`);
	}

	return json({ token: data.access_token ?? data.key });
};

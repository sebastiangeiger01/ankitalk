import { json, error } from '@sveltejs/kit';
import { explainCard } from '$lib/server/explain';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const apiKey = platform?.env.ANTHROPIC_API_KEY;
	if (!apiKey) throw error(500, 'Anthropic API key not configured');

	const body = (await request.json()) as { front: string; back: string };
	const { front, back } = body;

	if (!front || !back) {
		throw error(400, 'Missing front or back text');
	}

	const explanation = await explainCard(apiKey, front, back);
	return json({ explanation });
};

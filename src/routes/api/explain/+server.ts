import { json, error } from '@sveltejs/kit';
import { explainCard } from '$lib/server/explain';
import { getUserApiKey } from '$lib/server/user-keys';
import { logUsage, calculateExplainCost } from '$lib/server/usage';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	const db = getDb(platform!);

	const apiKey = await getUserApiKey(db, userId, 'anthropic', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) return json({ error: 'Add your Anthropic API key in Settings to use AI explanations' }, { status: 400 });

	const body = (await request.json()) as { front: string; back: string; locale?: string };
	const { front, back, locale } = body;

	if (!front || !back) {
		throw error(400, 'Missing front or back text');
	}

	const { explanation, inputTokens, outputTokens } = await explainCard(apiKey, front, back, locale);

	const cost = calculateExplainCost(inputTokens, outputTokens);
	const usagePromise = logUsage(db, userId, 'anthropic', 'explain', inputTokens + outputTokens, cost);
	platform?.context?.waitUntil(usagePromise);

	return json({ explanation });
};

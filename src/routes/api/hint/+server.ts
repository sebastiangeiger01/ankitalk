import { json, error } from '@sveltejs/kit';
import { hintCard } from '$lib/server/hint';
import { getUserApiKey } from '$lib/server/user-keys';
import { logUsage, calculateExplainCost } from '$lib/server/usage';
import { getDb } from '$lib/server/db';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/rate-limit';
import { normalizeLocale, requireField } from '$lib/server/validate';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	const db = getDb(platform!);

	await enforceRateLimit(platform!.env.KV, userId, 'anthropic', RATE_LIMITS.anthropic_per_minute.limit, RATE_LIMITS.anthropic_per_minute.windowSec);

	const apiKey = await getUserApiKey(db, userId, 'anthropic', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) return json({ error: 'Add your Anthropic API key in Settings to use AI hints' }, { status: 400 });

	const body = (await request.json().catch(() => ({}))) as { front?: unknown; back?: unknown; locale?: unknown };
	const front = requireField(body.front, 'front');
	const back = requireField(body.back, 'back');
	const locale = normalizeLocale(body.locale);

	const { hint, inputTokens, outputTokens } = await hintCard(apiKey, front, back, locale);

	const cost = calculateExplainCost(inputTokens, outputTokens);
	const usagePromise = logUsage(db, userId, 'anthropic', 'hint', inputTokens + outputTokens, cost);
	platform?.context?.waitUntil(usagePromise);

	return json({ hint });
};

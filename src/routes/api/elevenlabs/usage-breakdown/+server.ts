import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserApiKey } from '$lib/server/user-keys';
import type { RequestHandler } from './$types';

/**
 * Where the ElevenLabs credits actually went, over the trailing window — broken down both by
 * product (Speech Synthesis, Conversational AI, Speech to Text, …) and by model (Flash v2.5,
 * v3, …). Complements /elevenlabs/subscription, which only reports the remaining balance.
 *
 * Uses the character-stats usage endpoint with metric=credits; it's marked deprecated in favour
 * of the workspace analytics query, but character-stats is available on the individual tiers our
 * users are on and returns a simple time-series we sum.
 */

interface CharacterStats {
	time?: number[];
	usage?: Record<string, number[]>;
}

export interface BreakdownSection {
	total: number;
	items: { key: string; credits: number }[];
}

export interface UsageBreakdown {
	periodDays: number;
	product: BreakdownSection | null;
	model: BreakdownSection | null;
}

const PERIOD_DAYS = 30;

async function fetchBreakdown(
	apiKey: string,
	breakdownType: 'product_type' | 'model',
	startUnix: number,
	endUnix: number
): Promise<BreakdownSection | null> {
	const params = new URLSearchParams({
		start_unix: String(startUnix),
		end_unix: String(endUnix),
		breakdown_type: breakdownType,
		metric: 'credits'
	});
	const res = await fetch(`https://api.elevenlabs.io/v1/usage/character-stats?${params}`, {
		headers: { 'xi-api-key': apiKey }
	});
	// Tolerate a single breakdown failing (e.g. a tier that doesn't support `model`): the caller
	// still shows whatever did come back.
	if (!res.ok) return null;

	const data = (await res.json().catch(() => ({}))) as CharacterStats;
	const usage = data.usage ?? {};
	const items = Object.entries(usage)
		.map(([key, series]) => ({
			key,
			credits: Math.max(0, Math.round((series ?? []).reduce((sum, n) => sum + (n || 0), 0)))
		}))
		.filter((item) => item.credits > 0)
		.sort((a, b) => b.credits - a.credits);
	if (items.length === 0) return null;
	const total = items.reduce((sum, item) => sum + item.credits, 0);
	return { total, items };
}

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const apiKey = await getUserApiKey(db, locals.userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) return json({ error: 'no_key' }, { status: 400 });

	const end = Date.now();
	const start = end - PERIOD_DAYS * 24 * 60 * 60 * 1000;

	const [product, model] = await Promise.all([
		fetchBreakdown(apiKey, 'product_type', start, end),
		fetchBreakdown(apiKey, 'model', start, end)
	]);

	const body: UsageBreakdown = { periodDays: PERIOD_DAYS, product, model };
	return json(body, { headers: { 'Cache-Control': 'private, max-age=300' } });
};

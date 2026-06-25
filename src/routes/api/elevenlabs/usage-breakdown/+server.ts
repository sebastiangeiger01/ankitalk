import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserApiKey } from '$lib/server/user-keys';
import type { RequestHandler } from './$types';

/**
 * Where the ElevenLabs credits actually went, by product (Speech Synthesis, Conversational AI,
 * Speech to Text, …), over the trailing window. Complements /elevenlabs/subscription, which only
 * reports the remaining balance. Uses the character-stats usage endpoint with metric=credits;
 * it's marked deprecated in favour of the workspace analytics query, but character-stats is
 * available on the individual tiers our users are on and returns a simple time-series we sum.
 */

interface CharacterStats {
	time?: number[];
	usage?: Record<string, number[]>;
}

export interface UsageBreakdown {
	periodDays: number;
	total: number;
	items: { key: string; credits: number }[];
}

const PERIOD_DAYS = 30;

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const apiKey = await getUserApiKey(db, locals.userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) return json({ error: 'no_key' }, { status: 400 });

	const end = Date.now();
	const start = end - PERIOD_DAYS * 24 * 60 * 60 * 1000;
	const params = new URLSearchParams({
		start_unix: String(start),
		end_unix: String(end),
		breakdown_type: 'product_type',
		metric: 'credits'
	});

	const res = await fetch(`https://api.elevenlabs.io/v1/usage/character-stats?${params}`, {
		headers: { 'xi-api-key': apiKey }
	});
	if (!res.ok) {
		throw error(res.status === 401 ? 400 : 502, 'Failed to load ElevenLabs usage breakdown');
	}

	const data = (await res.json().catch(() => ({}))) as CharacterStats;
	const usage = data.usage ?? {};
	const items = Object.entries(usage)
		.map(([key, series]) => ({
			key,
			credits: Math.max(0, Math.round((series ?? []).reduce((sum, n) => sum + (n || 0), 0)))
		}))
		.filter((item) => item.credits > 0)
		.sort((a, b) => b.credits - a.credits);
	const total = items.reduce((sum, item) => sum + item.credits, 0);

	const body: UsageBreakdown = { periodDays: PERIOD_DAYS, total, items };
	return json(body, { headers: { 'Cache-Control': 'private, max-age=300' } });
};

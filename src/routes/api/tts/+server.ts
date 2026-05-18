import { error, json } from '@sveltejs/kit';
import { synthesizeSpeech } from '$lib/server/tts';
import { getUserApiKey } from '$lib/server/user-keys';
import { logUsage, calculateTtsCost } from '$lib/server/usage';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

async function makeTtsCacheRequest(
	userId: string,
	text: string,
	voice?: string,
	speed?: number
): Promise<Request> {
	const payload = JSON.stringify([userId, text.slice(0, 4096), voice ?? 'nova', speed ?? 1.0]);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
	const hash = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return new Request(`https://tts-cache.internal/v1/${hash}`);
}

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	const db = getDb(platform!);

	const body = (await request.json()) as { text: string; voice?: string; speed?: number };
	const { text, voice, speed } = body;

	if (!text || typeof text !== 'string') {
		throw error(400, 'Missing text');
	}

	// Check Cloudflare edge cache before hitting OpenAI or even fetching the API key.
	// Cache key encodes all synthesis parameters so different voices/speeds get separate entries.
	const cache = typeof caches !== 'undefined'
		? (caches as unknown as { default: Cache }).default
		: null;
	const cacheKey = cache ? await makeTtsCacheRequest(userId, text, voice, speed) : null;

	if (cache && cacheKey) {
		const cached = await cache.match(cacheKey);
		if (cached) return cached;
	}

	const apiKey = await getUserApiKey(db, userId, 'openai', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) return json({ error: 'Add your OpenAI API key in Settings to use text-to-speech' }, { status: 400 });

	const response = await synthesizeSpeech(apiKey, text, voice as Parameters<typeof synthesizeSpeech>[2], speed);

	// Cache the synthesized audio at the edge and log usage in the background.
	const cost = calculateTtsCost(text.length);
	const bgWork: Promise<unknown>[] = [logUsage(db, userId, 'openai', 'tts', text.length, cost)];
	if (cache && cacheKey) bgWork.push(cache.put(cacheKey, response.clone()));
	platform?.context?.waitUntil(Promise.all(bgWork));

	return response;
};

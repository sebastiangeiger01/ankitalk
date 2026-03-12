import { error, json } from '@sveltejs/kit';
import { synthesizeSpeech } from '$lib/server/tts';
import { getUserApiKey } from '$lib/server/user-keys';
import { logUsage, calculateTtsCost } from '$lib/server/usage';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	const db = getDb(platform!);

	const apiKey = await getUserApiKey(db, userId, 'openai', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) return json({ error: 'Add your OpenAI API key in Settings to use text-to-speech' }, { status: 400 });

	const body = (await request.json()) as { text: string; voice?: string; speed?: number };
	const { text, voice, speed } = body;

	if (!text || typeof text !== 'string') {
		throw error(400, 'Missing text');
	}

	const response = await synthesizeSpeech(apiKey, text, voice as Parameters<typeof synthesizeSpeech>[2], speed);

	const cost = calculateTtsCost(text.length);
	const usagePromise = logUsage(db, userId, 'openai', 'tts', text.length, cost);
	platform?.context?.waitUntil(usagePromise);

	return response;
};

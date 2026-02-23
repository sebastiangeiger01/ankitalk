import { error } from '@sveltejs/kit';
import { synthesizeSpeech } from '$lib/server/tts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const apiKey = platform?.env.OPENAI_API_KEY;
	if (!apiKey) throw error(500, 'OpenAI API key not configured');

	const body = (await request.json()) as { text: string; voice?: string; speed?: number };
	const { text, voice, speed } = body;

	if (!text || typeof text !== 'string') {
		throw error(400, 'Missing text');
	}

	return synthesizeSpeech(apiKey, text, voice as Parameters<typeof synthesizeSpeech>[2], speed);
};

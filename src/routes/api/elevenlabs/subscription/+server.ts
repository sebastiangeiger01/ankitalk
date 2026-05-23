import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserApiKey } from '$lib/server/user-keys';
import type { RequestHandler } from './$types';

interface ElevenLabsSubscription {
	tier?: string;
	character_count?: number;
	character_limit?: number;
	next_character_count_reset_unix?: number;
	status?: string;
}

export interface SubscriptionInfo {
	tier: string;
	characterCount: number;
	characterLimit: number;
	charactersRemaining: number;
	nextResetUnix: number | null;
	status: string;
}

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const apiKey = await getUserApiKey(db, locals.userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) return json({ error: 'Add your ElevenLabs API key in Settings to see your credit balance' }, { status: 400 });

	const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
		headers: { 'xi-api-key': apiKey }
	});

	if (!res.ok) {
		throw error(res.status === 401 ? 400 : 502, 'Failed to load ElevenLabs subscription');
	}

	const data = (await res.json().catch(() => ({}))) as ElevenLabsSubscription;
	const characterCount = data.character_count ?? 0;
	const characterLimit = data.character_limit ?? 0;

	const info: SubscriptionInfo = {
		tier: data.tier ?? 'free',
		characterCount,
		characterLimit,
		charactersRemaining: Math.max(0, characterLimit - characterCount),
		nextResetUnix: data.next_character_count_reset_unix ?? null,
		status: data.status ?? 'active'
	};

	return json(info, { headers: { 'Cache-Control': 'private, max-age=60' } });
};

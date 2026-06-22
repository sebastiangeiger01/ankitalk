import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { logUsage, calculateAgentConversationCost } from '$lib/server/usage';
import type { RequestHandler } from './$types';

/**
 * Client-reported session end. We log the duration to `api_usage` so the user can see
 * agent spend trends in Settings → Usage. The client number is authoritative because
 * ElevenLabs doesn't expose per-conversation cost via API — but we cap it at 30 minutes
 * so a malicious or buggy client can't insert a 100-hour bogus row.
 */
const MAX_SESSION_SECONDS = 30 * 60;

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');
	const body = (await request.json().catch(() => ({}))) as { duration_seconds?: unknown };
	const raw = Number(body.duration_seconds);
	if (!Number.isFinite(raw) || raw <= 0) return json({ ok: true });
	const seconds = Math.min(MAX_SESSION_SECONDS, Math.round(raw));
	const cost = calculateAgentConversationCost(seconds);
	const db = getDb(platform!);
	await logUsage(db, locals.userId, 'elevenlabs', 'agent_conversation', seconds, cost);
	return json({ ok: true });
};

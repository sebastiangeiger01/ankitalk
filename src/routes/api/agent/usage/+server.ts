import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

interface UsageRow {
	seconds: number | null;
	cost: number | null;
}

/**
 * Returns agent conversation usage logged through AnkiTalk for the current calendar month.
 * The real ElevenLabs quota lives on their dashboard (no public API for CAI minutes), so
 * this only reflects spend the user has incurred *via this app*, not their total month.
 */
export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');
	const db = getDb(platform!);
	const row = await db
		.prepare(
			`SELECT
				COALESCE(SUM(units), 0) AS seconds,
				COALESCE(SUM(estimated_cost_usd), 0) AS cost
			 FROM api_usage
			 WHERE user_id = ?
			   AND service = 'elevenlabs'
			   AND operation = 'agent_conversation'
			   AND created_at >= datetime('now', 'start of month')`
		)
		.bind(locals.userId)
		.first<UsageRow>();
	const seconds = Math.max(0, Math.round(row?.seconds ?? 0));
	const cost = Math.max(0, row?.cost ?? 0);
	return json({ month_seconds: seconds, month_cost_usd: cost });
};

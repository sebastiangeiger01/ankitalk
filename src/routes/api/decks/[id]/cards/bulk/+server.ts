import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const body = (await request.json()) as {
		action: 'suspend' | 'unsuspend';
		cardIds: string[];
	};

	if (!['suspend', 'unsuspend'].includes(body.action)) {
		throw error(400, 'Invalid action');
	}

	if (!Array.isArray(body.cardIds) || body.cardIds.length === 0) {
		throw error(400, 'cardIds must be a non-empty array');
	}

	const db = getDb(platform!);

	// Verify deck ownership
	const deck = await db
		.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first();
	if (!deck) throw error(404, 'Deck not found');

	const suspended = body.action === 'suspend' ? 1 : 0;

	// Batch update in chunks of 500
	let updated = 0;
	const chunkSize = 500;

	for (let i = 0; i < body.cardIds.length; i += chunkSize) {
		const chunk = body.cardIds.slice(i, i + chunkSize);
		const placeholders = chunk.map(() => '?').join(',');

		const result = await db
			.prepare(
				`UPDATE cards SET suspended = ?, updated_at = datetime('now')
				WHERE id IN (${placeholders}) AND deck_id = ? AND user_id = ?`
			)
			.bind(suspended, ...chunk, params.id, locals.userId)
			.run();

		updated += result.meta?.changes ?? 0;
	}

	return json({ updated });
};

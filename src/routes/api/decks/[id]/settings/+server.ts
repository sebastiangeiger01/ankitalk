import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import type { RequestHandler } from './$types';

const DEFAULTS = {
	new_cards_per_day: 20,
	max_reviews_per_day: 200,
	desired_retention: 0.9,
	max_interval: 36500,
	leech_threshold: 8
};

export const GET: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);

	// Verify deck ownership
	const deck = await db
		.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first();

	if (!deck) throw error(404, 'Deck not found');

	const settings = await db
		.prepare('SELECT * FROM deck_settings WHERE deck_id = ?')
		.bind(params.id)
		.first();

	return json({ settings: settings ?? { deck_id: params.id, ...DEFAULTS } });
};

export const PUT: RequestHandler = async ({ params, request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);

	// Verify deck ownership
	const deck = await db
		.prepare('SELECT id FROM decks WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first();

	if (!deck) throw error(404, 'Deck not found');

	const body = (await request.json()) as Record<string, unknown>;

	const newCardsPerDay = Math.max(0, Math.min(9999, Number(body.new_cards_per_day ?? DEFAULTS.new_cards_per_day)));
	const maxReviewsPerDay = Math.max(0, Math.min(9999, Number(body.max_reviews_per_day ?? DEFAULTS.max_reviews_per_day)));
	const desiredRetention = Math.max(0.5, Math.min(0.99, Number(body.desired_retention ?? DEFAULTS.desired_retention)));
	const maxInterval = Math.max(1, Math.min(36500, Math.round(Number(body.max_interval ?? DEFAULTS.max_interval))));
	const leechThreshold = Math.max(1, Math.min(99, Math.round(Number(body.leech_threshold ?? DEFAULTS.leech_threshold))));

	await db
		.prepare(
			`INSERT INTO deck_settings (deck_id, new_cards_per_day, max_reviews_per_day, desired_retention, max_interval, leech_threshold, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
			ON CONFLICT(deck_id) DO UPDATE SET
				new_cards_per_day = excluded.new_cards_per_day,
				max_reviews_per_day = excluded.max_reviews_per_day,
				desired_retention = excluded.desired_retention,
				max_interval = excluded.max_interval,
				leech_threshold = excluded.leech_threshold,
				updated_at = excluded.updated_at`
		)
		.bind(params.id, newCardsPerDay, maxReviewsPerDay, desiredRetention, maxInterval, leechThreshold)
		.run();

	return json({
		settings: {
			deck_id: params.id,
			new_cards_per_day: newCardsPerDay,
			max_reviews_per_day: maxReviewsPerDay,
			desired_retention: desiredRetention,
			max_interval: maxInterval,
			leech_threshold: leechThreshold
		}
	});
};

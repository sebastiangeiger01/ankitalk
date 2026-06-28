import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { parseSteps } from '$lib/fsrs';
import type { RequestHandler } from './$types';

const DEFAULTS = {
	new_cards_per_day: 20,
	max_reviews_per_day: 200,
	desired_retention: 0.9,
	max_interval: 36500,
	leech_threshold: 8,
	learning_steps: '1,10',
	relearning_steps: '10'
};

/**
 * Normalize a user-supplied exam-pin date. Accepts `YYYY-MM-DD` and stores it as end-of-day so
 * the pin stays active through the whole exam day (the TTS path compares against `datetime('now')`).
 * Empty / null clears the pin. Returns `undefined` for malformed input so the caller can 400.
 */
function normalizeKeepUntil(value: unknown): string | null | undefined {
	if (value === null || value === '' || value === undefined) return null;
	if (typeof value !== 'string') return undefined;
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (!match) return undefined;
	const date = new Date(`${match[0]}T23:59:59Z`);
	if (Number.isNaN(date.getTime())) return undefined;
	return `${match[0]} 23:59:59`;
}

export const GET: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);

	// Verify deck ownership
	const deck = await db
		.prepare('SELECT id, audio_keep_until FROM decks WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first<{ id: string; audio_keep_until: string | null }>();

	if (!deck) throw error(404, 'Deck not found');

	const settings = await db
		.prepare('SELECT * FROM deck_settings WHERE deck_id = ?')
		.bind(params.id)
		.first();

	return json({
		settings: settings ?? { deck_id: params.id, ...DEFAULTS },
		// Surfaced as a plain YYYY-MM-DD for the date picker (null when not pinned).
		audio_keep_until: deck.audio_keep_until ? deck.audio_keep_until.slice(0, 10) : null
	});
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

	// Exam-pin retention for cached audio (separate column on `decks`). Only touched when the
	// client actually sends the field, so a normal settings save doesn't clear an existing pin.
	if ('audio_keep_until' in body) {
		const keepUntil = normalizeKeepUntil(body.audio_keep_until);
		if (keepUntil === undefined) throw error(400, 'Invalid audio_keep_until (expected YYYY-MM-DD)');
		await db
			.prepare('UPDATE decks SET audio_keep_until = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?')
			.bind(keepUntil, params.id, locals.userId)
			.run();
	}

	const newCardsPerDay = Math.max(0, Math.min(9999, Number(body.new_cards_per_day ?? DEFAULTS.new_cards_per_day)));
	const maxReviewsPerDay = Math.max(0, Math.min(9999, Number(body.max_reviews_per_day ?? DEFAULTS.max_reviews_per_day)));
	const desiredRetention = Math.max(0.5, Math.min(0.99, Number(body.desired_retention ?? DEFAULTS.desired_retention)));
	const maxInterval = Math.max(1, Math.min(36500, Math.round(Number(body.max_interval ?? DEFAULTS.max_interval))));
	const leechThreshold = Math.max(1, Math.min(99, Math.round(Number(body.leech_threshold ?? DEFAULTS.leech_threshold))));

	// Validate learning steps: must be comma-separated positive numbers
	const rawLearningSteps = typeof body.learning_steps === 'string' ? body.learning_steps : DEFAULTS.learning_steps;
	const rawRelearningSteps = typeof body.relearning_steps === 'string' ? body.relearning_steps : DEFAULTS.relearning_steps;
	const learningSteps = parseSteps(rawLearningSteps).join(',') || DEFAULTS.learning_steps;
	const relearningSteps = parseSteps(rawRelearningSteps).join(',') || DEFAULTS.relearning_steps;

	await db
		.prepare(
			`INSERT INTO deck_settings (deck_id, new_cards_per_day, max_reviews_per_day, desired_retention, max_interval, leech_threshold, learning_steps, relearning_steps, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
			ON CONFLICT(deck_id) DO UPDATE SET
				new_cards_per_day = excluded.new_cards_per_day,
				max_reviews_per_day = excluded.max_reviews_per_day,
				desired_retention = excluded.desired_retention,
				max_interval = excluded.max_interval,
				leech_threshold = excluded.leech_threshold,
				learning_steps = excluded.learning_steps,
				relearning_steps = excluded.relearning_steps,
				updated_at = excluded.updated_at`
		)
		.bind(params.id, newCardsPerDay, maxReviewsPerDay, desiredRetention, maxInterval, leechThreshold, learningSteps, relearningSteps)
		.run();

	return json({
		settings: {
			deck_id: params.id,
			new_cards_per_day: newCardsPerDay,
			max_reviews_per_day: maxReviewsPerDay,
			desired_retention: desiredRetention,
			max_interval: maxInterval,
			leech_threshold: leechThreshold,
			learning_steps: learningSteps,
			relearning_steps: relearningSteps
		}
	});
};

import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { fsrs, createEmptyCard, Rating, State } from 'ts-fsrs';
import type { Card as FSRSCard } from 'ts-fsrs';
import { parseSteps, hardDelayMinutes } from '$lib/fsrs';
import type { RequestHandler } from './$types';

/**
 * Format a scheduled interval into a human-readable string like AnkiWeb.
 */
function formatInterval(scheduledDays: number, dueDate: Date, now: Date): string {
	const diffMs = dueDate.getTime() - now.getTime();
	const diffMinutes = diffMs / (1000 * 60);
	const diffHours = diffMs / (1000 * 60 * 60);
	const diffDays = diffMs / (1000 * 60 * 60 * 24);

	if (diffMinutes < 1) return '<1m';
	if (diffHours < 1) return `${Math.round(diffMinutes)}m`;
	if (diffDays < 1) return `${Math.round(diffHours)}h`;
	if (diffDays < 30) return `${Math.round(diffDays)}d`;
	if (diffDays < 365) {
		const months = diffDays / 30;
		return months >= 10 ? `${Math.round(months)}mo` : `${months.toFixed(1).replace(/\.0$/, '')}mo`;
	}
	const years = diffDays / 365;
	return years >= 10 ? `${Math.round(years)}y` : `${years.toFixed(1).replace(/\.0$/, '')}y`;
}

function formatMinutes(minutes: number): string {
	if (minutes < 60) return `${Math.round(minutes)}m`;
	const hours = minutes / 60;
	if (hours < 24) return `${Math.round(hours)}h`;
	const days = hours / 24;
	return `${Math.round(days)}d`;
}

/**
 * Convert a DB card row to an FSRS card for scheduling preview.
 */
function rowToFsrsCard(row: Record<string, unknown>): FSRSCard {
	const reps = (row.fsrs_reps as number) ?? 0;
	if (reps === 0) {
		return createEmptyCard(new Date((row.due_at as string) ?? new Date().toISOString()));
	}
	return {
		due: new Date((row.due_at as string) ?? new Date().toISOString()),
		stability: (row.fsrs_stability as number) ?? 0,
		difficulty: (row.fsrs_difficulty as number) ?? 0,
		elapsed_days: (row.fsrs_elapsed_days as number) ?? 0,
		scheduled_days: (row.fsrs_scheduled_days as number) ?? 0,
		reps,
		lapses: (row.fsrs_lapses as number) ?? 0,
		state: ((row.fsrs_state as number) ?? 0) as State,
		last_review: row.fsrs_last_review ? new Date(row.fsrs_last_review as string) : undefined
	};
}

/**
 * Compute preview intervals for all 4 ratings on a card,
 * using traditional learning steps for New/Learning/Relearning states.
 */
function computeIntervals(
	row: Record<string, unknown>,
	scheduler: ReturnType<typeof fsrs>,
	now: Date,
	learningSteps: number[],
	relearningSteps: number[]
): { again: string; hard: string; good: string; easy: string } {
	const state = ((row.fsrs_state as number) ?? 0) as State;
	const stepIndex = (row.learning_step_index as number) ?? 0;

	// For New/Learning: show learning step intervals
	if ((state === State.New || state === State.Learning) && learningSteps.length > 0) {
		const fsrsCard = rowToFsrsCard(row);
		const fsrsGood = scheduler.repeat(fsrsCard, now)[Rating.Good];
		const fsrsEasy = scheduler.repeat(fsrsCard, now)[Rating.Easy];

		const againInterval = formatMinutes(learningSteps[0]);
		const hardInterval = formatMinutes(hardDelayMinutes(learningSteps, stepIndex));
		const nextStep = stepIndex + 1;
		const goodInterval = nextStep >= learningSteps.length
			? formatInterval(fsrsGood.card.scheduled_days, fsrsGood.card.due, now)
			: formatMinutes(learningSteps[nextStep]);
		const easyInterval = formatInterval(fsrsEasy.card.scheduled_days, fsrsEasy.card.due, now);

		return { again: againInterval, hard: hardInterval, good: goodInterval, easy: easyInterval };
	}

	// For Relearning: show relearning step intervals
	if (state === State.Relearning && relearningSteps.length > 0) {
		const fsrsCard = rowToFsrsCard(row);
		const fsrsGood = scheduler.repeat(fsrsCard, now)[Rating.Good];
		const fsrsEasy = scheduler.repeat(fsrsCard, now)[Rating.Easy];

		const againInterval = formatMinutes(relearningSteps[0]);
		const hardInterval = formatMinutes(hardDelayMinutes(relearningSteps, stepIndex));
		const nextStep = stepIndex + 1;
		const goodInterval = nextStep >= relearningSteps.length
			? formatInterval(fsrsGood.card.scheduled_days, fsrsGood.card.due, now)
			: formatMinutes(relearningSteps[nextStep]);
		const easyInterval = formatInterval(fsrsEasy.card.scheduled_days, fsrsEasy.card.due, now);

		return { again: againInterval, hard: hardInterval, good: goodInterval, easy: easyInterval };
	}

	// Review state: pure FSRS, but Again enters relearning
	const fsrsCard = rowToFsrsCard(row);
	const result = scheduler.repeat(fsrsCard, now);

	const againInterval = relearningSteps.length > 0
		? formatMinutes(relearningSteps[0])
		: formatInterval(result[Rating.Again].card.scheduled_days, result[Rating.Again].card.due, now);

	return {
		again: againInterval,
		hard: formatInterval(result[Rating.Hard].card.scheduled_days, result[Rating.Hard].card.due, now),
		good: formatInterval(result[Rating.Good].card.scheduled_days, result[Rating.Good].card.due, now),
		easy: formatInterval(result[Rating.Easy].card.scheduled_days, result[Rating.Easy].card.due, now)
	};
}

/** Day boundary: 4 AM UTC (matches Anki's default rollover) */
function todayStart(): string {
	const now = new Date();
	const d = new Date(now);
	d.setUTCHours(4, 0, 0, 0);
	if (now < d) {
		// Before 4 AM UTC — "today" started yesterday at 4 AM
		d.setUTCDate(d.getUTCDate() - 1);
	}
	return d.toISOString();
}

export const GET: RequestHandler = async ({ url, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const deckId = url.searchParams.get('deckId');
	if (!deckId) throw error(400, 'Missing deckId');

	const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50') || 50, 200);
	const mode = url.searchParams.get('mode'); // 'cram' or null
	const tagsParam = url.searchParams.get('tags'); // comma-separated tags
	const cramState = url.searchParams.get('cramState'); // optional state filter for cram

	const db = getDb(platform!);

	// Verify deck ownership
	const deck = await db
		.prepare('SELECT id, name FROM decks WHERE id = ? AND user_id = ?')
		.bind(deckId, locals.userId)
		.first<{ id: string; name: string }>();

	if (!deck) throw error(404, 'Deck not found');

	// Build tag filter clause + binds
	let tagClause = '';
	const tagBinds: string[] = [];
	if (tagsParam) {
		const tags = tagsParam.split(',').map((t) => t.trim()).filter(Boolean);
		if (tags.length > 0) {
			const tagConditions = tags.map(() => "(' ' || n.tags || ' ') LIKE ?");
			tagClause = ' AND (' + tagConditions.join(' OR ') + ')';
			for (const tag of tags) {
				tagBinds.push(`% ${tag} %`);
			}
		}
	}

	const now = new Date().toISOString();

	// Load deck settings for FSRS scheduler + learning steps
	const fsrsSettings = await db
		.prepare('SELECT desired_retention, max_interval, learning_steps, relearning_steps FROM deck_settings WHERE deck_id = ?')
		.bind(deckId)
		.first<{ desired_retention: number; max_interval: number; learning_steps: string; relearning_steps: string }>();

	const scheduler = fsrs({
		request_retention: fsrsSettings?.desired_retention ?? 0.9,
		maximum_interval: fsrsSettings?.max_interval ?? 36500
	});
	const learningSteps = parseSteps(fsrsSettings?.learning_steps ?? '1,10');
	const relearningSteps = parseSteps(fsrsSettings?.relearning_steps ?? '10');
	const intervalNow = new Date();

	// Cram mode: skip daily limits, ignore due_at filter, different ordering
	if (mode === 'cram') {
		let stateClause = '';
		const stateBinds: number[] = [];
		if (cramState === 'new') {
			stateClause = ' AND c.fsrs_state = 0';
		} else if (cramState === 'learning') {
			stateClause = ' AND c.fsrs_state IN (1, 3)';
		} else if (cramState === 'review') {
			stateClause = ' AND c.fsrs_state = 2';
		}

		const cards = await db
			.prepare(
				`SELECT c.*, n.model_name, n.fields, n.tags
				FROM cards c
				JOIN notes n ON n.id = c.note_id
				WHERE c.deck_id = ? AND c.user_id = ?
					AND c.suspended = 0
					AND (c.buried_until IS NULL OR c.buried_until <= ?)
					${stateClause}${tagClause}
				ORDER BY c.fsrs_reps ASC, RANDOM()
				LIMIT ?`
			)
			.bind(deckId, locals.userId, now, ...stateBinds, ...tagBinds, limit)
			.all();

		const cramCards = (cards.results as Record<string, unknown>[]).map((c) => ({
			...c,
			intervals: computeIntervals(c, scheduler, intervalNow, learningSteps, relearningSteps)
		}));
		return json({ cards: cramCards, deckName: deck.name, mode: 'cram' });
	}

	// Normal mode
	// Load deck settings (or use defaults)
	const settings = await db
		.prepare('SELECT new_cards_per_day, max_reviews_per_day FROM deck_settings WHERE deck_id = ?')
		.bind(deckId)
		.first<{ new_cards_per_day: number; max_reviews_per_day: number }>();

	const newPerDay = settings?.new_cards_per_day ?? 20;
	const maxReviews = settings?.max_reviews_per_day ?? 200;

	// Count today's completions (since 4 AM UTC)
	const dayStart = todayStart();

	const counts = await db
		.prepare(
			`SELECT
				SUM(CASE WHEN c.fsrs_state = 0 THEN 1 ELSE 0 END) as new_done,
				SUM(CASE WHEN c.fsrs_state = 2 THEN 1 ELSE 0 END) as review_done
			FROM reviews r
			JOIN cards c ON c.id = r.card_id
			WHERE r.deck_id = ? AND r.user_id = ? AND r.created_at >= ?`
		)
		.bind(deckId, locals.userId, dayStart)
		.first<{ new_done: number | null; review_done: number | null }>();

	const newDone = counts?.new_done ?? 0;
	const reviewDone = counts?.review_done ?? 0;

	const newRemaining = Math.max(0, newPerDay - newDone);
	const reviewRemaining = Math.max(0, maxReviews - reviewDone);

	// Fetch cards in priority order:
	// 1. Learning/Relearning (state 1,3) — no limit, due now
	// 2. Review (state 2) — limited (wrapped in subquery for UNION ALL compatibility)
	// 3. New (state 0) — limited (wrapped in subquery for UNION ALL compatibility)
	// Exclude buried cards
	const cards = await db
		.prepare(
			`SELECT * FROM (
				-- Learning / Relearning: no daily limit
				SELECT c.*, n.model_name, n.fields, n.tags, 0 as sort_priority
				FROM cards c
				JOIN notes n ON n.id = c.note_id
				WHERE c.deck_id = ? AND c.user_id = ?
					AND c.fsrs_state IN (1, 3)
					AND c.due_at <= ?
					AND (c.buried_until IS NULL OR c.buried_until <= ?)
					AND c.suspended = 0
					${tagClause}

				UNION ALL

				-- Review: daily limit (subquery to allow ORDER BY + LIMIT in UNION)
				SELECT * FROM (
					SELECT c.*, n.model_name, n.fields, n.tags, 1 as sort_priority
					FROM cards c
					JOIN notes n ON n.id = c.note_id
					WHERE c.deck_id = ? AND c.user_id = ?
						AND c.fsrs_state = 2
						AND c.due_at <= ?
						AND (c.buried_until IS NULL OR c.buried_until <= ?)
						AND c.suspended = 0
						${tagClause}
					ORDER BY c.due_at ASC
					LIMIT ?
				)

				UNION ALL

				-- New: daily limit (subquery to allow ORDER BY + LIMIT in UNION)
				SELECT * FROM (
					SELECT c.*, n.model_name, n.fields, n.tags, 2 as sort_priority
					FROM cards c
					JOIN notes n ON n.id = c.note_id
					WHERE c.deck_id = ? AND c.user_id = ?
						AND c.fsrs_state = 0
						AND c.due_at <= ?
						AND (c.buried_until IS NULL OR c.buried_until <= ?)
						AND c.suspended = 0
						${tagClause}
					ORDER BY c.due_at ASC
					LIMIT ?
				)
			)
			ORDER BY sort_priority ASC, due_at ASC
			LIMIT ?`
		)
		.bind(
			// Learning
			deckId, locals.userId, now, now, ...tagBinds,
			// Review
			deckId, locals.userId, now, now, ...tagBinds, reviewRemaining,
			// New
			deckId, locals.userId, now, now, ...tagBinds, newRemaining,
			// Overall
			limit
		)
		.all();

	const rawCards = cards.results as Record<string, unknown>[];

	// Compute queue counts for the top bar (new / learning / review)
	let newCount = 0;
	let learningCount = 0;
	let reviewCount = 0;
	for (const c of rawCards) {
		const state = (c.fsrs_state as number) ?? 0;
		if (state === 0) newCount++;
		else if (state === 1 || state === 3) learningCount++;
		else if (state === 2) reviewCount++;
	}

	const results = rawCards.map((c) => ({
		...c,
		intervals: computeIntervals(c, scheduler, intervalNow, learningSteps, relearningSteps)
	}));

	return json({
		cards: results,
		deckName: deck.name,
		mode: 'normal',
		counts: { new: newCount, learning: learningCount, review: reviewCount }
	});
};

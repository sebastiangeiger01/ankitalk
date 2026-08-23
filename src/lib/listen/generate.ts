/**
 * Batch sizing for the client-driven "generate the whole document" loop.
 *
 * The batch has to be small enough that one request finishes comfortably inside a single
 * Worker invocation — synthesis dominates, at roughly half a second to a couple of seconds per
 * sentence — and large enough that a long document doesn't turn into hundreds of round trips.
 * Ten is about a ten-second request in the common case.
 */
export const DEFAULT_GENERATE_BATCH = 10;
export const MAX_GENERATE_BATCH = 25;

/**
 * Clamp a client-supplied batch size; anything unusable falls back to the default.
 *
 * Note the deliberate rejection of non-numbers before coercing: `Number(null)` and `Number('')`
 * are both 0, which would clamp to a batch of one and turn a long document into ten times as
 * many round trips as it needs.
 */
export function clampGenerateBatch(raw: unknown): number {
	const n =
		typeof raw === 'number'
			? raw
			: typeof raw === 'string' && raw.trim() !== ''
				? Number(raw)
				: Number.NaN;
	if (!Number.isFinite(n)) return DEFAULT_GENERATE_BATCH;
	return Math.max(1, Math.min(MAX_GENERATE_BATCH, Math.floor(n)));
}

export interface GenerateProgress {
	generated: number;
	remaining: number;
	total: number;
	cached: number;
	error?: string;
}

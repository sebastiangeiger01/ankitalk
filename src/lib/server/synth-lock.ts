/**
 * Atomic generation locks, backed by D1.
 *
 * Two isolates that miss the cache for the same clip at the same moment would both call the
 * paid speech provider. A lock closes that window — but it used to live in Workers KV, which
 * charges a write on acquire and a delete on release against a free-tier budget of 1,000 of
 * each per day, for the whole account. One long listen document is one lock per sentence, so
 * generating a few hundred sentences could spend the day's entire KV allowance and take every
 * other KV-backed feature down with it, the rate limiter included.
 *
 * D1 is the better home in both directions. It is far roomier, and `INSERT` against a primary
 * key is genuinely atomic, so this is a real compare-and-set rather than the read-then-write
 * race the KV version could only narrow — which its own comments admitted.
 */

/** Locks auto-expire so a crashed generator can never wedge a clip permanently. */
export const SYNTH_LOCK_TTL_SECONDS = 60;

/**
 * Try to take the lock. Returns true if it is ours.
 *
 * The upsert only fires when the existing row has already expired, so a live lock leaves the
 * statement affecting no rows — `changes === 0` is exactly "someone else is generating this".
 * An abandoned lock is reclaimed by the same statement, no cleanup pass required.
 */
export async function acquireSynthLock(
	db: D1Database,
	lockKey: string,
	ttlSeconds = SYNTH_LOCK_TTL_SECONDS
): Promise<boolean> {
	try {
		const res = await db
			.prepare(
				`INSERT INTO synth_locks (lock_key, expires_at)
				 VALUES (?, datetime('now', '+${ttlSeconds} seconds'))
				 ON CONFLICT(lock_key) DO UPDATE SET
					expires_at = excluded.expires_at
				 WHERE synth_locks.expires_at <= datetime('now')`
			)
			.bind(lockKey)
			.run();
		return (res.meta?.changes ?? 0) > 0;
	} catch {
		// A lock we cannot take is not a reason to refuse work the user asked for: proceed and
		// accept the small chance of generating a clip twice.
		return true;
	}
}

/** Release the lock. Best-effort — an unreleased lock expires on its own. */
export async function releaseSynthLock(db: D1Database, lockKey: string): Promise<void> {
	try {
		await db.prepare('DELETE FROM synth_locks WHERE lock_key = ?').bind(lockKey).run();
	} catch {
		/* the TTL is the backstop */
	}
}

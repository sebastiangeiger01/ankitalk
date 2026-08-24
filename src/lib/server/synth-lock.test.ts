import { describe, expect, it } from 'vitest';
import { acquireSynthLock, releaseSynthLock } from './synth-lock';

/** D1 fake that models the conditional upsert's affected-row count. */
function makeDb(opts: { changes?: number; throws?: boolean } = {}) {
	const runs: { sql: string; args: unknown[] }[] = [];
	const db = {
		runs,
		prepare(sql: string) {
			return {
				bind: (...args: unknown[]) => ({
					run: async () => {
						if (opts.throws) throw new Error('D1 unavailable');
						runs.push({ sql: sql.replace(/\s+/g, ' ').trim(), args });
						return { success: true, meta: { changes: opts.changes ?? 1 } };
					}
				})
			};
		}
	};
	return db as unknown as D1Database & { runs: typeof runs };
}

describe('acquireSynthLock', () => {
	it('reports ownership when the upsert affected a row', async () => {
		const db = makeDb({ changes: 1 });
		expect(await acquireSynthLock(db, 'listen:u1:h1')).toBe(true);
	});

	it('reports contention when a live lock left the upsert a no-op', async () => {
		// This is the whole point of using D1: the affected-row count is decided atomically,
		// unlike the read-then-write the KV version could only narrow.
		const db = makeDb({ changes: 0 });
		expect(await acquireSynthLock(db, 'listen:u1:h1')).toBe(false);
	});

	it('reclaims the lock only through the expiry guard in the statement', async () => {
		const db = makeDb();
		await acquireSynthLock(db, 'listen:u1:h1');
		const sql = db.runs[0].sql;
		expect(sql).toContain('ON CONFLICT(lock_key) DO UPDATE');
		expect(sql).toContain("WHERE synth_locks.expires_at <= datetime('now')");
	});

	it('proceeds rather than blocking work when D1 itself fails', async () => {
		// A lock we cannot take must not stop audio the user is waiting for; the cost of being
		// wrong is one duplicate generation, not a broken feature.
		expect(await acquireSynthLock(makeDb({ throws: true }), 'k')).toBe(true);
	});

	it('never throws on release', async () => {
		await expect(releaseSynthLock(makeDb({ throws: true }), 'k')).resolves.toBeUndefined();
	});
});

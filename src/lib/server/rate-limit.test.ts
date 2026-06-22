import { describe, expect, it } from 'vitest';
import { enforceRateLimit } from './rate-limit';

/** Minimal KVNamespace fake with the two methods we touch. */
function makeKv() {
	const store = new Map<string, string>();
	return {
		store,
		kv: {
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string) => void store.set(k, v)
		} as unknown as KVNamespace
	};
}

describe('enforceRateLimit', () => {
	it('allows requests below the limit', async () => {
		const { kv } = makeKv();
		for (let i = 0; i < 3; i++) {
			await expect(enforceRateLimit(kv, 'u1', 'bucket', 5, 60)).resolves.toBeUndefined();
		}
	});

	it('throws 429 once the limit is reached', async () => {
		const { kv } = makeKv();
		for (let i = 0; i < 5; i++) {
			await enforceRateLimit(kv, 'u1', 'bucket', 5, 60);
		}
		await expect(enforceRateLimit(kv, 'u1', 'bucket', 5, 60)).rejects.toMatchObject({
			status: 429
		});
	});

	it('keeps separate counters per user', async () => {
		const { kv } = makeKv();
		for (let i = 0; i < 5; i++) await enforceRateLimit(kv, 'u1', 'bucket', 5, 60);
		// u2 should still be allowed even though u1 has hit the cap.
		await expect(enforceRateLimit(kv, 'u2', 'bucket', 5, 60)).resolves.toBeUndefined();
	});

	it('keeps separate counters per bucket', async () => {
		const { kv } = makeKv();
		for (let i = 0; i < 5; i++) await enforceRateLimit(kv, 'u1', 'a', 5, 60);
		// Different bucket name → independent counter.
		await expect(enforceRateLimit(kv, 'u1', 'b', 5, 60)).resolves.toBeUndefined();
	});

	it('namespaces KV keys so other usages cannot collide', async () => {
		const { store, kv } = makeKv();
		await enforceRateLimit(kv, 'u1', 'bucket', 5, 60);
		const keys = [...store.keys()];
		expect(keys.every((k) => k.startsWith('rl:bucket:u1:'))).toBe(true);
	});
});

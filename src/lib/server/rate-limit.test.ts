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

describe('enforceRateLimit when KV is unavailable', () => {
	/** KV whose operations reject, as they do once the account's daily budget is spent. */
	function brokenKv(mode: 'read' | 'write') {
		return {
			get: async () => {
				if (mode === 'read') throw new Error('KV daily limit exceeded');
				return '0';
			},
			put: async () => {
				throw new Error('KV daily limit exceeded');
			}
		} as unknown as KVNamespace;
	}

	it('allows the request through when the counter cannot be read', async () => {
		// The alternative is a 500 on every rate-limited endpoint at once — review audio, hints,
		// the tutor, MCP and listening all go through this function.
		await expect(enforceRateLimit(brokenKv('read'), 'u1', 'b', 5, 60)).resolves.toBeUndefined();
	});

	it('allows the request through when the counter cannot be written', async () => {
		await expect(enforceRateLimit(brokenKv('write'), 'u1', 'b', 5, 60)).resolves.toBeUndefined();
	});
});

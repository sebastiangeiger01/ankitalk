import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrSynthesizeSentence } from './listen-tts';
import type { ElevenLabsTtsSettings } from './tts';

const settings: ElevenLabsTtsSettings = {
	elevenlabs_voice_id: 'voice',
	elevenlabs_tts_model: 'eleven_flash_v2_5',
	elevenlabs_tts_speed: 1,
	elevenlabs_stability: 0.5,
	elevenlabs_similarity: 0.75,
	elevenlabs_style: 0,
	elevenlabs_speaker_boost: true
};

/** Minimal D1 fake: records every run() and lets a test control what first() returns. */
function makeDb(firstValue: unknown = null) {
	const runs: { sql: string; args: unknown[] }[] = [];
	const db = {
		runs,
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						first: async () => firstValue,
						run: async () => {
							runs.push({ sql, args });
							return { success: true } as unknown;
						},
						all: async () => ({ results: [] })
					};
				}
			};
		}
	};
	return db as unknown as D1Database & { runs: typeof runs };
}

function makeR2(existing: Map<string, Uint8Array> = new Map()) {
	const puts: { key: string }[] = [];
	const bucket = {
		puts,
		get: async (key: string) => {
			const bytes = existing.get(key);
			if (!bytes) return null;
			return { arrayBuffer: async () => bytes.buffer };
		},
		put: async (key: string, _body: unknown) => {
			puts.push({ key });
			return {} as unknown;
		}
	};
	return bucket as unknown as R2Bucket & { puts: typeof puts };
}

function makeKv() {
	const store = new Map<string, string>();
	return {
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		delete: async (k: string) => void store.delete(k)
	} as unknown as KVNamespace;
}

/** Collect waitUntil promises so the test can await side effects (logUsage, cache-expiry refresh). */
function makeWaitUntil() {
	const pending: Promise<unknown>[] = [];
	const waitUntil = (p: Promise<unknown>) => void pending.push(Promise.resolve(p).catch(() => undefined));
	return { waitUntil, settle: () => Promise.all(pending) };
}

function mockFetchReturning(byteLength: number) {
	return vi.fn(async () => new Response(new Uint8Array(byteLength), { status: 200 }));
}

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe('getOrSynthesizeSentence — billing guards', () => {
	it('does NOT cache or bill when ElevenLabs returns an empty/truncated body', async () => {
		const fetchMock = mockFetchReturning(10); // below MIN_AUDIO_BYTES
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const db = makeDb(null);
		const media = makeR2();
		const { waitUntil, settle } = makeWaitUntil();

		await expect(
			getOrSynthesizeSentence(db, media, makeKv(), 'u1', 'key', 'A sentence long enough to synthesize.', 38, 'hash1', settings, 'de', waitUntil)
		).rejects.toThrow();
		await settle();

		expect(media.puts).toHaveLength(0); // never wrote audio to R2
		const billed = db.runs.filter((r) => r.sql.includes('api_usage'));
		const cached = db.runs.filter((r) => r.sql.includes('listen_sentence_cache') && r.sql.includes('INSERT'));
		expect(billed).toHaveLength(0); // never logged usage
		expect(cached).toHaveLength(0); // never inserted a cache row
	});

	it('caches and bills exactly once for a valid body', async () => {
		const fetchMock = mockFetchReturning(40_000); // ~2.5s of 128kbps audio
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const db = makeDb(null);
		const media = makeR2();
		const { waitUntil, settle } = makeWaitUntil();

		const result = await getOrSynthesizeSentence(
			db, media, makeKv(), 'u1', 'key', 'A sentence long enough to synthesize.', 38, 'hash1', settings, 'de', waitUntil
		);
		await settle();

		expect(result.cached).toBe(false);
		expect(result.bytes.byteLength).toBe(40_000);
		expect(media.puts).toHaveLength(1);
		expect(db.runs.filter((r) => r.sql.includes('api_usage'))).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('serves from cache without calling ElevenLabs or billing', async () => {
		const fetchMock = mockFetchReturning(40_000);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const r2Key = 'listen-cache/u1/hash1.mp3';
		const db = makeDb({ r2_key: r2Key, char_count: 38, byte_size: 40_000, duration_ms: 2500 });
		const media = makeR2(new Map([[r2Key, new Uint8Array(40_000)]]));
		const { waitUntil, settle } = makeWaitUntil();

		const result = await getOrSynthesizeSentence(
			db, media, makeKv(), 'u1', 'key', 'A sentence long enough to synthesize.', 38, 'hash1', settings, 'de', waitUntil
		);
		await settle();

		expect(result.cached).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(media.puts).toHaveLength(0);
		expect(db.runs.filter((r) => r.sql.includes('api_usage'))).toHaveLength(0);
	});

	it('dedupes concurrent same-isolate requests into a single generation+bill', async () => {
		const fetchMock = mockFetchReturning(40_000);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const db = makeDb(null);
		const media = makeR2();
		const { waitUntil, settle } = makeWaitUntil();

		const args = ['u1', 'key', 'A sentence long enough to synthesize.', 38, 'hashX', settings, 'de'] as const;
		const [a, b] = await Promise.all([
			getOrSynthesizeSentence(db, media, makeKv(), ...args, waitUntil),
			getOrSynthesizeSentence(db, media, makeKv(), ...args, waitUntil)
		]);
		await settle();

		expect(a.bytes.byteLength).toBe(40_000);
		expect(b.bytes.byteLength).toBe(40_000);
		expect(fetchMock).toHaveBeenCalledTimes(1); // only one ElevenLabs call
		expect(db.runs.filter((r) => r.sql.includes('api_usage'))).toHaveLength(1); // billed once
	});
});

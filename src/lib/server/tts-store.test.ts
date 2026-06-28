// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
	getCacheEventStats,
	getTtsCacheStats,
	isDeckAudioPinned,
	recordCacheEvent,
	recordCachedAudio,
	ttsHash,
	PIN_RETENTION_DAYS,
	STD_RETENTION_DAYS
} from './tts-store';

describe('ttsHash', () => {
	it('is a stable 64-char hex digest', async () => {
		const hash = await ttsHash('payload');
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(await ttsHash('payload')).toBe(hash);
	});

	it('separates different payloads (so voices/speeds never collide)', async () => {
		expect(await ttsHash('a')).not.toBe(await ttsHash('b'));
	});
});

describe('retention windows', () => {
	it('keeps pinned audio longer than the default idle window', () => {
		expect(PIN_RETENTION_DAYS).toBeGreaterThan(STD_RETENTION_DAYS);
	});
});

function dbThatThrows(message: string): D1Database {
	const statement = {
		bind: () => statement,
		first: () => Promise.reject(new Error(message)),
		run: () => Promise.reject(new Error(message)),
		all: () => Promise.reject(new Error(message))
	};
	return {
		prepare: () => statement,
		batch: () => Promise.reject(new Error(message))
	} as unknown as D1Database;
}

describe('optional TTS cache schema', () => {
	it('treats a missing deck pin column as unpinned audio', async () => {
		await expect(isDeckAudioPinned(dbThatThrows('no such column: audio_keep_until'), 'u1', 'd1')).resolves.toBe(false);
	});

	it('does not fail TTS when cache index tables are not migrated yet', async () => {
		const db = dbThatThrows('no such table: tts_audio');
		await expect(recordCachedAudio(db, 'u1', 'hash', 123, false)).resolves.toBeUndefined();
		await expect(getTtsCacheStats(db, 'u1')).resolves.toEqual({ clips: 0, bytes: 0, pinned_clips: 0 });
	});

	it('does not fail TTS when cache event tables are not migrated yet', async () => {
		const db = dbThatThrows('no such table: tts_cache_events');
		await expect(recordCacheEvent(db, 'u1', 'miss', 12, 'hash')).resolves.toBeUndefined();
		await expect(getCacheEventStats(db, 'u1', true)).resolves.toEqual({
			by_status: [],
			hits: 0,
			misses: 0,
			saved_chars: 0,
			spent_chars: 0,
			recent: []
		});
	});
});

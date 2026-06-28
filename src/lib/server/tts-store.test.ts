// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ttsHash, PIN_RETENTION_DAYS, STD_RETENTION_DAYS } from './tts-store';

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

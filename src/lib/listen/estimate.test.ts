import { describe, expect, it } from 'vitest';
import { estimateCredits, hashContent } from './estimate';

describe('estimateCredits', () => {
	it('bills Flash/Turbo at half credits and standard at full', () => {
		expect(estimateCredits(1000, 'eleven_flash_v2_5')).toBe(500);
		expect(estimateCredits(1000, 'eleven_turbo_v2_5')).toBe(500);
		expect(estimateCredits(1000, 'eleven_multilingual_v2')).toBe(1000);
		expect(estimateCredits(1000, 'eleven_v3')).toBe(1000);
	});

	it('treats unknown models as full credits', () => {
		expect(estimateCredits(1000, 'unknown')).toBe(1000);
	});
});

describe('hashContent', () => {
	it('is stable across whitespace-only differences', async () => {
		const a = await hashContent('Hello   world', 'v1', 'm1');
		const b = await hashContent('Hello world', 'v1', 'm1');
		expect(a).toBe(b);
	});

	it('changes when voice or model changes', async () => {
		const base = await hashContent('Hello world', 'v1', 'm1');
		expect(await hashContent('Hello world', 'v2', 'm1')).not.toBe(base);
		expect(await hashContent('Hello world', 'v1', 'm2')).not.toBe(base);
	});

	it('changes when meaningful text changes', async () => {
		const a = await hashContent('Hello world', 'v1', 'm1');
		const b = await hashContent('Goodbye world', 'v1', 'm1');
		expect(a).not.toBe(b);
	});
});

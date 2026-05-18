import { describe, expect, it } from 'vitest';
import { getUsageSummary } from './usage';

describe('usage summary', () => {
	it('includes ElevenLabs in service totals', async () => {
		const db = {
			prepare: () => ({
				bind: () => ({
					all: async () => ({
						results: [
							{ service: 'elevenlabs', today: 0.01, week: 0.02, month: 0.03 },
							{ service: 'openai', today: 0.02, week: 0.03, month: 0.04 }
						]
					})
				})
			})
		} as unknown as D1Database;

		const summary = await getUsageSummary(db, 'user-1');

		expect(summary.today.elevenlabs).toBe(0.01);
		expect(summary.today.total).toBeCloseTo(0.03);
		expect(summary.week.total).toBeCloseTo(0.05);
		expect(summary.month.total).toBeCloseTo(0.07);
	});
});

import { newId } from './db';

// Rates (USD)
const RATES = {
	openai_tts: 0.6 / 1_000_000, // $0.60 per 1M characters
	deepgram_stt: 0.0043, // $0.0043 per second
	anthropic_input: 1.0 / 1_000_000, // $1.00 per 1M input tokens
	anthropic_output: 5.0 / 1_000_000 // $5.00 per 1M output tokens
};

export async function logUsage(
	db: D1Database,
	userId: string,
	service: 'openai' | 'deepgram' | 'anthropic',
	operation: 'tts' | 'stt_token' | 'explain',
	units: number,
	estimatedCostUsd: number
): Promise<void> {
	await db
		.prepare(
			'INSERT INTO api_usage (id, user_id, service, operation, units, estimated_cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))'
		)
		.bind(newId(), userId, service, operation, units, estimatedCostUsd)
		.run();
}

export function calculateTtsCost(characterCount: number): number {
	return characterCount * RATES.openai_tts;
}

export function calculateSttCost(estimatedSeconds: number): number {
	return estimatedSeconds * RATES.deepgram_stt;
}

export function calculateExplainCost(inputTokens: number, outputTokens: number): number {
	return inputTokens * RATES.anthropic_input + outputTokens * RATES.anthropic_output;
}

export type UsagePeriod = {
	openai: number;
	deepgram: number;
	anthropic: number;
	total: number;
};

export async function getUsageSummary(
	db: D1Database,
	userId: string
): Promise<{ today: UsagePeriod; week: UsagePeriod; month: UsagePeriod }> {
	const query = `
		SELECT
			service,
			SUM(CASE WHEN created_at >= datetime('now', 'start of day')   THEN estimated_cost_usd ELSE 0 END) AS today,
			SUM(CASE WHEN created_at >= datetime('now', '-7 days')         THEN estimated_cost_usd ELSE 0 END) AS week,
			SUM(CASE WHEN created_at >= datetime('now', 'start of month')  THEN estimated_cost_usd ELSE 0 END) AS month
		FROM api_usage
		WHERE user_id = ?
		GROUP BY service
	`;

	const rows = await db
		.prepare(query)
		.bind(userId)
		.all<{ service: string; today: number; week: number; month: number }>();

	const empty = (): UsagePeriod => ({ openai: 0, deepgram: 0, anthropic: 0, total: 0 });
	const today = empty();
	const week = empty();
	const month = empty();

	for (const row of rows.results) {
		const svc = row.service as 'openai' | 'deepgram' | 'anthropic';
		if (svc === 'openai' || svc === 'deepgram' || svc === 'anthropic') {
			today[svc] = row.today ?? 0;
			week[svc] = row.week ?? 0;
			month[svc] = row.month ?? 0;
		}
	}

	today.total = today.openai + today.deepgram + today.anthropic;
	week.total = week.openai + week.deepgram + week.anthropic;
	month.total = month.openai + month.deepgram + month.anthropic;

	return { today, week, month };
}

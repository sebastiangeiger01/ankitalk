import { newId } from './db';
import { elevenLabsModelCreditMultiplier } from '$lib/voice';

// Rates (USD)
const RATES = {
	openai_tts: 0.6 / 1_000_000, // $0.60 per 1M characters
	deepgram_stt: 0.0043 / 60, // $0.0043 per minute → per second
	elevenlabs_tts: 0.36 / 1_000_000, // standard model (1 credit/char); Flash/Turbo bill at half
	elevenlabs_stt: 0.0048 / 60, // rough subscription-dependent estimate
	anthropic_input: 1.0 / 1_000_000, // $1.00 per 1M input tokens
	anthropic_output: 5.0 / 1_000_000, // $5.00 per 1M output tokens
	// Rough estimate of agent conversation cost per second on Creator/Pro tiers. Real billing
	// is opaque (no public API) and varies by underlying LLM + voice tier — this is a
	// "good-enough" budget tracker so the user can see usage trending, not a true invoice.
	elevenlabs_agent: 0.10 / 60 // ~$0.10/minute → per second
};

export type UsageService = 'openai' | 'deepgram' | 'anthropic' | 'elevenlabs';
export type UsageOperation = 'tts' | 'stt_token' | 'explain' | 'hint' | 'agent_conversation';

export async function logUsage(
	db: D1Database,
	userId: string,
	service: UsageService,
	operation: UsageOperation,
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

export function calculateElevenLabsTtsCost(characterCount: number, modelId?: string): number {
	const multiplier = modelId ? elevenLabsModelCreditMultiplier(modelId) : 1;
	return characterCount * RATES.elevenlabs_tts * multiplier;
}

export function calculateSttCost(estimatedSeconds: number): number {
	return estimatedSeconds * RATES.deepgram_stt;
}

export function calculateElevenLabsSttCost(estimatedSeconds: number): number {
	return estimatedSeconds * RATES.elevenlabs_stt;
}

export function calculateExplainCost(inputTokens: number, outputTokens: number): number {
	return inputTokens * RATES.anthropic_input + outputTokens * RATES.anthropic_output;
}

/** Estimated USD spend for an agent conversation of the given duration. */
export function calculateAgentConversationCost(durationSeconds: number): number {
	return Math.max(0, durationSeconds) * RATES.elevenlabs_agent;
}

export type UsagePeriod = {
	openai: number;
	deepgram: number;
	anthropic: number;
	elevenlabs: number;
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

	const empty = (): UsagePeriod => ({ openai: 0, deepgram: 0, anthropic: 0, elevenlabs: 0, total: 0 });
	const today = empty();
	const week = empty();
	const month = empty();

	for (const row of rows.results) {
		const svc = row.service as UsageService;
		if (svc === 'openai' || svc === 'deepgram' || svc === 'anthropic' || svc === 'elevenlabs') {
			today[svc] = row.today ?? 0;
			week[svc] = row.week ?? 0;
			month[svc] = row.month ?? 0;
		}
	}

	today.total = today.openai + today.deepgram + today.anthropic + today.elevenlabs;
	week.total = week.openai + week.deepgram + week.anthropic + week.elevenlabs;
	month.total = month.openai + month.deepgram + month.anthropic + month.elevenlabs;

	return { today, week, month };
}

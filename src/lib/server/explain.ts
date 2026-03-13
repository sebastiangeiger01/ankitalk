import Anthropic from '@anthropic-ai/sdk';

export type ExplainResult = {
	explanation: string;
	inputTokens: number;
	outputTokens: number;
};

/**
 * Get a concise explanation for a flashcard using Claude Haiku.
 */
export async function explainCard(
	apiKey: string,
	front: string,
	back: string
): Promise<ExplainResult> {
	const client = new Anthropic({ apiKey });

	const message = await client.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: 300,
		system: [
			{
				type: 'text',
				text: 'You are a tutor helping a student truly understand a flashcard answer. Your job is to add context that is not already in the question or answer — explain the underlying principle, share an etymology, give a real-world application, or use a memorable analogy. Do NOT merely restate or paraphrase what the student already read. If you cannot add genuine new context, give a concrete example instead. Keep it to 2-3 sentences. Use plain conversational language; no bullet points, no markdown, because your response will be read aloud.',
				cache_control: { type: 'ephemeral' }
			}
		],
		messages: [
			{
				role: 'user',
				content: `Question: ${front}\nAnswer: ${back}\n\nHelp me understand this more deeply.`
			}
		]
	});

	const textBlock = message.content.find((b) => b.type === 'text');
	return {
		explanation: textBlock?.text ?? 'Sorry, I could not generate an explanation.',
		inputTokens: message.usage.input_tokens,
		outputTokens: message.usage.output_tokens
	};
}

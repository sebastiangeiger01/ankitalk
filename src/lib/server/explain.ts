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
				text: 'You are a tutor helping a student understand a flashcard. Give a clear, concise explanation (2-4 sentences) of why the answer is correct. Speak directly to the student. Do not repeat the question or answer verbatim.',
				cache_control: { type: 'ephemeral' }
			}
		],
		messages: [
			{
				role: 'user',
				content: `Flashcard question: ${front}\nFlashcard answer: ${back}\n\nExplain why this is the answer.`
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

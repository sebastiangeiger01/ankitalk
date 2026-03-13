import Anthropic from '@anthropic-ai/sdk';

const LOCALE_NAMES: Record<string, string> = {
	en: 'English',
	de: 'German'
};

function languageInstruction(locale?: string): string {
	const lang = locale ? (LOCALE_NAMES[locale] ?? locale) : 'English';
	return `Respond in ${lang}. If the flashcard content is clearly written in a different language, respond in that language instead.`;
}

export type HintResult = {
	hint: string;
	inputTokens: number;
	outputTokens: number;
};

/**
 * Get a nudging hint for a flashcard using Claude Haiku.
 * Guides the student toward the answer without revealing it.
 */
export async function hintCard(
	apiKey: string,
	front: string,
	back: string,
	locale?: string
): Promise<HintResult> {
	const client = new Anthropic({ apiKey });

	const message = await client.messages.create({
		model: 'claude-haiku-4-5-20251001',
		max_tokens: 100,
		system: [
			{
				type: 'text',
				text: `You are a tutor helping a student recall a flashcard answer. Give exactly one short hint that nudges them toward the answer without revealing it. Good hints use: the category the answer belongs to, its first letter or syllable, a synonym, a related concept, or context already present in the question. Never state the answer directly. Use plain conversational language; no markdown, because your response will be read aloud. ${languageInstruction(locale)}`,
				cache_control: { type: 'ephemeral' }
			}
		],
		messages: [
			{
				role: 'user',
				content: `The student sees: "${front}"\nThe correct answer is: "${back}"\n\nGive a hint without revealing the answer.`
			}
		]
	});

	const textBlock = message.content.find((b) => b.type === 'text');
	return {
		hint: textBlock?.text ?? 'Sorry, I could not generate a hint.',
		inputTokens: message.usage.input_tokens,
		outputTokens: message.usage.output_tokens
	};
}

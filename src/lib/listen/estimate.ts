import { elevenLabsModelCreditMultiplier } from '$lib/voice';

/** ElevenLabs credits consumed for `chars` with the given model (Flash/Turbo bill at half). */
export function estimateCredits(chars: number, modelId: string): number {
	return Math.ceil(chars * elevenLabsModelCreditMultiplier(modelId));
}

/**
 * Stable content hash for duplicate detection. Normalizes whitespace so trivially different
 * pastes of the same text collide, and folds in the voice/model so re-generating with a
 * different voice is treated as distinct.
 */
export async function hashContent(
	text: string,
	voiceId: string,
	modelId: string,
	language = ''
): Promise<string> {
	const normalized = text.replace(/\s+/g, ' ').trim();
	const payload = JSON.stringify([normalized, voiceId, modelId, language]);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

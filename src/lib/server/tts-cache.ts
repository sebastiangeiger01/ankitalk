import type { VoiceProvider } from '$lib/voice';

export function makeTtsCachePayload(
	userId: string,
	text: string,
	provider: VoiceProvider,
	model: string,
	voice: string,
	speed: number
): string {
	return JSON.stringify([userId, provider, model, text.slice(0, 5000), voice, speed]);
}

import type { VoiceProvider } from '$lib/voice';

export function makeTtsCachePayload(
	userId: string,
	text: string,
	provider: VoiceProvider,
	model: string,
	voice: string,
	speed: number,
	extra?: string
): string {
	const parts: unknown[] = [userId, provider, model, text.slice(0, 5000), voice, speed];
	if (extra !== undefined) parts.push(extra);
	return JSON.stringify(parts);
}

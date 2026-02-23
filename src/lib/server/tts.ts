import OpenAI from 'openai';

export type TTSVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

/**
 * Synthesize speech using OpenAI TTS API.
 * Returns a Response with audio/mpeg body for streaming.
 */
export async function synthesizeSpeech(
	apiKey: string,
	text: string,
	voice: TTSVoice = 'nova',
	speed: number = 1.0
): Promise<Response> {
	const openai = new OpenAI({ apiKey });

	const response = await openai.audio.speech.create({
		model: 'tts-1',
		voice,
		input: text.slice(0, 4096),
		response_format: 'mp3',
		speed: Math.max(0.25, Math.min(4.0, speed))
	});

	return new Response(response.body, {
		headers: {
			'Content-Type': 'audio/mpeg',
			'Cache-Control': 'public, max-age=86400'
		}
	});
}

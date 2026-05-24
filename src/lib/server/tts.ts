import OpenAI from 'openai';
import type { UserVoiceSettings } from '$lib/voice';

export type TTSVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

/**
 * Synthesize speech using OpenAI TTS API.
 * Returns a Response with audio/mpeg body for streaming.
 */
export async function synthesizeOpenAISpeech(
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

export type ElevenLabsTtsSettings = Pick<
	UserVoiceSettings,
	| 'elevenlabs_voice_id'
	| 'elevenlabs_tts_model'
	| 'elevenlabs_tts_speed'
	| 'elevenlabs_stability'
	| 'elevenlabs_similarity'
	| 'elevenlabs_style'
	| 'elevenlabs_speaker_boost'
>;

export async function synthesizeElevenLabsSpeech(
	apiKey: string,
	text: string,
	settings: ElevenLabsTtsSettings
): Promise<Response> {
	const voiceId = encodeURIComponent(settings.elevenlabs_voice_id);
	const response = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
		{
			method: 'POST',
			headers: {
				'xi-api-key': apiKey,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				text: text.slice(0, 5000),
				model_id: settings.elevenlabs_tts_model,
				voice_settings: {
					stability: settings.elevenlabs_stability,
					similarity_boost: settings.elevenlabs_similarity,
					style: settings.elevenlabs_style,
					use_speaker_boost: settings.elevenlabs_speaker_boost,
					speed: settings.elevenlabs_tts_speed
				}
			})
		}
	);

	if (!response.ok) {
		const message = await response.text().catch(() => '');
		throw new Error(`ElevenLabs TTS failed: ${response.status}${message ? ` ${message}` : ''}`);
	}

	return new Response(response.body, {
		headers: {
			'Content-Type': 'audio/mpeg',
			'Cache-Control': 'public, max-age=86400'
		}
	});
}

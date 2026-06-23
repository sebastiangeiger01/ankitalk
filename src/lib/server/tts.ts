import OpenAI from 'openai';
import type { UserVoiceSettings } from '$lib/voice';
import { modelSupportsLanguageCode } from '$lib/listen/languages';

export type TTSVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

/**
 * A speech provider (ElevenLabs/OpenAI) responded with a non-OK status. Carries the real
 * upstream status and body so the API route can surface it instead of collapsing every
 * provider failure into an opaque 500. A persistent failure across cards/decks is almost
 * always account-level here — `quota_exceeded` (out of credits) or `too_many_concurrent_requests`.
 */
export class TtsUpstreamError extends Error {
	readonly status: number;
	readonly detail: string;
	constructor(status: number, detail: string) {
		super(`TTS provider error ${status}${detail ? `: ${detail}` : ''}`);
		this.name = 'TtsUpstreamError';
		this.status = status;
		this.detail = detail;
	}
}

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

	let response;
	try {
		response = await openai.audio.speech.create({
			model: 'tts-1',
			voice,
			input: text.slice(0, 4096),
			response_format: 'mp3',
			speed: Math.max(0.25, Math.min(4.0, speed))
		});
	} catch (err) {
		const status = (err as { status?: unknown })?.status;
		if (typeof status === 'number') {
			throw new TtsUpstreamError(status, err instanceof Error ? err.message : '');
		}
		throw err;
	}

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
	settings: ElevenLabsTtsSettings,
	languageCode?: string
): Promise<Response> {
	const voiceId = encodeURIComponent(settings.elevenlabs_voice_id);
	const body: Record<string, unknown> = {
		text: text.slice(0, 5000),
		model_id: settings.elevenlabs_tts_model,
		voice_settings: {
			stability: settings.elevenlabs_stability,
			similarity_boost: settings.elevenlabs_similarity,
			style: settings.elevenlabs_style,
			use_speaker_boost: settings.elevenlabs_speaker_boost,
			speed: settings.elevenlabs_tts_speed
		}
	};
	// language_code is only honored by Flash/Turbo v2.5; sending it to other models errors.
	if (languageCode && modelSupportsLanguageCode(settings.elevenlabs_tts_model)) {
		body.language_code = languageCode;
	}

	const response = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
		{
			method: 'POST',
			headers: {
				'xi-api-key': apiKey,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(body)
		}
	);

	if (!response.ok) {
		const message = await response.text().catch(() => '');
		throw new TtsUpstreamError(response.status, message);
	}

	return new Response(response.body, {
		headers: {
			'Content-Type': 'audio/mpeg',
			'Cache-Control': 'public, max-age=86400'
		}
	});
}

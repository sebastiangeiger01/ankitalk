import type { ErrorCallback, SpeechClient, TranscriptCallback } from './speech';

const TARGET_SAMPLE_RATE = 16000;
const MAX_BUFFERED_BYTES = 1_000_000;

interface ElevenLabsTokenResponse {
	token: string;
	websocketUrl: string;
	modelId: string;
	audioFormat: 'pcm_16000';
	languageCode?: string;
	error?: string;
}

export interface ElevenLabsOptions {
	/** ISO language code used to bias STT, e.g. "en" or "de". */
	language?: string;
}

export interface ElevenLabsTranscriptEvent {
	message_type?: string;
	text?: string;
	message?: string;
	error?: string;
}

export function downsampleFloat32ToPCM16(
	input: Float32Array,
	inputSampleRate: number,
	targetSampleRate = TARGET_SAMPLE_RATE
): Int16Array {
	if (inputSampleRate <= 0) throw new Error('Invalid input sample rate');
	if (targetSampleRate <= 0) throw new Error('Invalid target sample rate');

	const ratio = inputSampleRate / targetSampleRate;
	const outputLength = Math.max(1, Math.floor(input.length / ratio));
	const output = new Int16Array(outputLength);

	for (let i = 0; i < outputLength; i++) {
		const start = Math.floor(i * ratio);
		const end = Math.min(input.length, Math.floor((i + 1) * ratio));
		let sum = 0;
		let count = 0;

		for (let j = start; j < end; j++) {
			sum += input[j];
			count++;
		}

		const sample = Math.max(-1, Math.min(1, count ? sum / count : input[start] ?? 0));
		output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
	}

	return output;
}

export function pcm16ToBase64(pcm: Int16Array): string {
	const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	let binary = '';
	const chunkSize = 0x8000;

	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}

	return btoa(binary);
}

export function parseElevenLabsTranscriptEvent(data: unknown): { text: string; isFinal: boolean } | null {
	if (!data || typeof data !== 'object') return null;
	const event = data as ElevenLabsTranscriptEvent;
	const text = typeof event.text === 'string' ? event.text.trim() : '';
	if (!text) return null;

	if (event.message_type === 'partial_transcript') return { text, isFinal: false };
	if (
		event.message_type === 'committed_transcript' ||
		event.message_type === 'committed_transcript_with_timestamps'
	) {
		return { text, isFinal: true };
	}

	return null;
}

function messageForElevenLabsError(data: ElevenLabsTranscriptEvent): string {
	const type = data.message_type ?? 'error';
	const detail = data.message ?? data.error;

	if (type.includes('quota')) return 'ElevenLabs quota exceeded';
	if (type.includes('rate') || type.includes('throttled')) return 'ElevenLabs rate limit reached';
	if (type.includes('auth')) return 'ElevenLabs authentication failed';
	if (type.includes('terms')) return 'Accept ElevenLabs speech-to-text terms before using voice commands';
	if (type.includes('input') || type.includes('chunk')) return 'ElevenLabs could not process microphone audio';

	return detail ? `ElevenLabs STT error: ${detail}` : 'ElevenLabs STT error';
}

export function createElevenLabsClient(options?: ElevenLabsOptions): SpeechClient {
	let socket: WebSocket | null = null;
	let stream: MediaStream | null = null;
	let audioContext: AudioContext | null = null;
	let source: MediaStreamAudioSourceNode | null = null;
	let processor: ScriptProcessorNode | null = null;
	let silentGain: GainNode | null = null;
	let transcriptCb: TranscriptCallback | null = null;
	let errorCb: ErrorCallback | null = null;
	let paused = false;
	let stopping = false;

	async function getConfig(): Promise<ElevenLabsTokenResponse> {
		const params = new URLSearchParams();
		if (options?.language) params.set('language', options.language);
		const res = await fetch(`/api/elevenlabs-realtime-token?${params}`);
		const data = (await res.json().catch(() => ({}))) as ElevenLabsTokenResponse;
		if (!res.ok) throw new Error(data.error ?? 'Failed to get ElevenLabs realtime token');
		return data;
	}

	function buildSocketUrl(config: ElevenLabsTokenResponse): string {
		const url = new URL(config.websocketUrl);
		url.searchParams.set('token', config.token);
		url.searchParams.set('model_id', config.modelId);
		url.searchParams.set('audio_format', config.audioFormat);
		url.searchParams.set('commit_strategy', 'vad');
		if (config.languageCode) url.searchParams.set('language_code', config.languageCode);
		return url.toString();
	}

	async function requestAudioStream() {
		const AudioContextCtor =
			window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AudioContextCtor) throw new Error('Browser does not support Web Audio microphone capture');

		stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			}
		});
		audioContext = new AudioContextCtor();
		if (audioContext.state === 'suspended') await audioContext.resume();
	}

	function connectAudioProcessor() {
		if (!stream || !audioContext) throw new Error('Microphone is not ready');

		source = audioContext.createMediaStreamSource(stream);
		processor = audioContext.createScriptProcessor(4096, 1, 1);
		silentGain = audioContext.createGain();
		silentGain.gain.value = 0;

		processor.onaudioprocess = (event) => {
			if (paused || socket?.readyState !== WebSocket.OPEN) return;
			if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;

			const input = event.inputBuffer.getChannelData(0);
			const pcm = downsampleFloat32ToPCM16(input, audioContext!.sampleRate);
			const audioBase64 = pcm16ToBase64(pcm);
			socket.send(JSON.stringify({
				message_type: 'input_audio_chunk',
				audio_base_64: audioBase64,
				sample_rate: TARGET_SAMPLE_RATE
			}));
		};

		source.connect(processor);
		processor.connect(silentGain);
		silentGain.connect(audioContext.destination);
	}

	function stopCapture() {
		if (processor) {
			processor.onaudioprocess = null;
			try { processor.disconnect(); } catch { /* already disconnected */ }
		}
		if (source) {
			try { source.disconnect(); } catch { /* already disconnected */ }
		}
		if (silentGain) {
			try { silentGain.disconnect(); } catch { /* already disconnected */ }
		}
		processor = null;
		source = null;
		silentGain = null;

		if (stream) {
			stream.getTracks().forEach((track) => track.stop());
		}
		stream = null;

		if (audioContext) {
			audioContext.close().catch(() => {});
		}
		audioContext = null;
	}

	async function openSocket(url: string): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			let opened = false;
			socket = new WebSocket(url);

			socket.onopen = () => {
				opened = true;
				resolve();
			};
			socket.onerror = () => {
				const err = new Error('ElevenLabs WebSocket error');
				if (opened) errorCb?.(err);
				else reject(err);
			};
			socket.onclose = (event) => {
				if (stopping || paused) return;
				const err = new Error(`ElevenLabs connection closed: ${event.code} ${event.reason}`);
				if (opened) errorCb?.(err);
				else reject(err);
			};
			socket.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data) as ElevenLabsTranscriptEvent;
					if (data.message_type?.includes('error')) {
						errorCb?.(new Error(messageForElevenLabsError(data)));
						return;
					}
					const transcript = parseElevenLabsTranscriptEvent(data);
					if (transcript) transcriptCb?.(transcript.text, transcript.isFinal);
				} catch {
					// Ignore non-JSON messages.
				}
			};
		});
	}

	async function start() {
		stopping = false;
		paused = false;

		try {
			await requestAudioStream();
			const config = await getConfig();
			await openSocket(buildSocketUrl(config));
			connectAudioProcessor();
		} catch (err) {
			stop();
			throw err;
		}
	}

	function stop() {
		stopping = true;
		paused = false;
		stopCapture();
		if (socket && socket.readyState === WebSocket.OPEN) {
			socket.close(1000, 'closed');
		}
		socket = null;
	}

	function pause() {
		paused = true;
		stopCapture();
	}

	function resume() {
		paused = false;
		if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
			start().catch((err) => errorCb?.(err instanceof Error ? err : new Error('ElevenLabs resume failed')));
			return;
		}
		requestAudioStream()
			.then(connectAudioProcessor)
			.catch((err) => errorCb?.(err instanceof Error ? err : new Error('ElevenLabs microphone resume failed')));
	}

	return {
		start,
		stop,
		pause,
		resume,
		onTranscript(cb: TranscriptCallback) {
			transcriptCb = cb;
		},
		onError(cb: ErrorCallback) {
			errorCb = cb;
		},
		getMediaStream() {
			return stream;
		}
	};
}

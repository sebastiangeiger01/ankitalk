import { downsampleFloat32ToPCM16 } from './elevenlabs';
import type { ErrorCallback, SpeechClient, TranscriptCallback } from './speech';

const TARGET_SAMPLE_RATE = 16000;
const MAX_BUFFERED_BYTES = 1_000_000;

/**
 * Create a Deepgram STT client that connects to Deepgram's WebSocket API
 * via a short-lived token obtained from our server.
 *
 * Audio is captured with Web Audio (ScriptProcessor → 16 kHz linear16 PCM), NOT
 * MediaRecorder: on iOS Safari MediaRecorder cannot stream — with an mp4 container
 * it buffers the whole recording and never emits timeslice chunks (and its webm
 * support is unreliable), so Deepgram received no audio and closed the socket with
 * 1011/net0001. This mirrors the ElevenLabs client's capture pipeline, which is
 * proven on the same devices.
 */
export interface DeepgramOptions {
	/** Deepgram language code (e.g. 'en', 'de', 'multi'). Default: 'multi'. */
	language?: string;
}

export function createDeepgramClient(options?: DeepgramOptions): SpeechClient {
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
	let keepAliveInterval: ReturnType<typeof setInterval> | null = null;

	function connectAudioProcessor() {
		if (!stream || !audioContext) {
			errorCb?.(new Error('Microphone is not ready'));
			return;
		}

		source = audioContext.createMediaStreamSource(stream);
		processor = audioContext.createScriptProcessor(4096, 1, 1);
		silentGain = audioContext.createGain();
		silentGain.gain.value = 0;

		processor.onaudioprocess = (event) => {
			if (paused || socket?.readyState !== WebSocket.OPEN) return;
			if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;

			const input = event.inputBuffer.getChannelData(0);
			const pcm = downsampleFloat32ToPCM16(input, audioContext!.sampleRate);
			socket.send(pcm.buffer);
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

	function clearKeepAlive() {
		if (keepAliveInterval) {
			clearInterval(keepAliveInterval);
			keepAliveInterval = null;
		}
	}

	async function start(providedStream?: MediaStream) {
		stopping = false;
		paused = false;

		// Adopt a caller-acquired stream immediately so stop() cleans it up even if a
		// later step throws.
		if (providedStream) stream = providedStream;

		const AudioContextCtor =
			window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AudioContextCtor) throw new Error('Browser does not support Web Audio microphone capture');

		try {
			// 1. Get short-lived token from our server
			const tokenRes = await fetch('/api/deepgram-token');
			if (!tokenRes.ok) {
				throw new Error('Failed to get Deepgram token');
			}
			const { token } = (await tokenRes.json()) as { token: string };
			if (!token) {
				throw new Error('Deepgram token is empty');
			}

			// 2. Microphone access (unless the caller handed a live stream in). Echo
			// cancellation matters: the mic stays open while cards play aloud, so without
			// it the TTS audio feeds back into STT and can trigger false voice commands.
			if (!stream) {
				stream = await navigator.mediaDevices.getUserMedia({
					audio: {
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true
					}
				});
			}

			audioContext = new AudioContextCtor();
			if (audioContext.state === 'suspended') await audioContext.resume();

			// 3. Connect to Deepgram, declaring the raw PCM format we stream.
			// JWT access tokens use "bearer" scheme (not "token" which is for API keys)
			const lang = options?.language ?? 'multi';
			const params: Record<string, string> = {
				model: 'nova-3',
				language: lang,
				smart_format: 'true',
				interim_results: 'true',
				endpointing: '300',
				encoding: 'linear16',
				sample_rate: String(TARGET_SAMPLE_RATE),
				channels: '1'
			};

			const url =
				'wss://api.deepgram.com/v1/listen?' +
				new URLSearchParams(params).toString();

			socket = new WebSocket(url, ['bearer', token]);

			socket.onopen = () => {
				// 4. Start streaming PCM chunks as the processor produces them.
				connectAudioProcessor();
			};

			socket.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					if (data.type === 'Results' && data.channel?.alternatives?.[0]) {
						const alt = data.channel.alternatives[0];
						const transcript = alt.transcript || '';
						const isFinal = data.is_final === true;
						if (transcript && transcriptCb) {
							transcriptCb(transcript, isFinal);
						}
					}
				} catch {
					// Ignore non-JSON messages
				}
			};

			socket.onerror = () => {
				errorCb?.(new Error('Deepgram WebSocket error'));
			};

			socket.onclose = (event) => {
				// Suppress timeout errors when mic is intentionally paused or torn down
				if (paused || stopping) return;
				if (event.code !== 1000 && event.code !== 1005) {
					errorCb?.(new Error(`Deepgram connection closed: ${event.code} ${event.reason}`));
				}
			};
		} catch (err) {
			stop();
			throw err;
		}
	}

	function stop() {
		stopping = true;
		paused = false;
		clearKeepAlive();
		stopCapture();

		// Send close signal to Deepgram
		if (socket && socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: 'CloseStream' }));
			socket.close();
		}
		socket = null;
	}

	function pause() {
		paused = true;

		// Disable audio tracks so the browser drops the mic indicator; the processor
		// keeps running on silence but the `paused` gate stops all sends.
		if (stream) {
			stream.getAudioTracks().forEach((track) => { track.enabled = false; });
		}

		// Send KeepAlive messages to Deepgram to prevent timeout while paused
		if (!keepAliveInterval) {
			keepAliveInterval = setInterval(() => {
				if (socket?.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify({ type: 'KeepAlive' }));
				}
			}, 8000);
		}
	}

	function resume() {
		paused = false;
		clearKeepAlive();

		// If Deepgram closed the socket anyway (long pause, network blip), restart the
		// whole pipeline — re-enabling tracks alone would stream into a dead socket.
		if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
			stopCapture();
			start().catch((err) => errorCb?.(err instanceof Error ? err : new Error('Deepgram resume failed')));
			return;
		}

		// Re-enable audio tracks
		if (stream) {
			stream.getAudioTracks().forEach((track) => { track.enabled = true; });
		}
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

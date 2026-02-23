type TranscriptCallback = (transcript: string, isFinal: boolean) => void;
type ErrorCallback = (error: Error) => void;

export interface DeepgramClient {
	start(): Promise<void>;
	stop(): void;
	onTranscript(cb: TranscriptCallback): void;
	onError(cb: ErrorCallback): void;
}

/**
 * Create a Deepgram STT client that connects to Deepgram's WebSocket API
 * via a short-lived token obtained from our server.
 */
export function createDeepgramClient(): DeepgramClient {
	let socket: WebSocket | null = null;
	let mediaRecorder: MediaRecorder | null = null;
	let stream: MediaStream | null = null;
	let transcriptCb: TranscriptCallback | null = null;
	let errorCb: ErrorCallback | null = null;

	async function start() {
		// 1. Get short-lived token from our server
		const tokenRes = await fetch('/api/deepgram-token');
		if (!tokenRes.ok) {
			throw new Error('Failed to get Deepgram token');
		}
		const { token } = (await tokenRes.json()) as { token: string };

		// 2. Get microphone access
		stream = await navigator.mediaDevices.getUserMedia({ audio: true });

		if (!token) {
			throw new Error('Deepgram token is empty');
		}

		// 3. Connect to Deepgram WebSocket
		// JWT access tokens use "bearer" scheme (not "token" which is for API keys)
		const params: Record<string, string> = {
			model: 'nova-3',
			language: 'multi',
			smart_format: 'true',
			interim_results: 'true',
			endpointing: '300'
		};

		// Tell Deepgram the encoding if we're not sending webm
		if (!MediaRecorder.isTypeSupported('audio/webm')) {
			params.encoding = 'linear16';
			params.sample_rate = '16000';
		}

		const url =
			'wss://api.deepgram.com/v1/listen?' +
			new URLSearchParams(params).toString();

		socket = new WebSocket(url, ['bearer', token]);

		socket.onopen = () => {
			// 4. Start recording and sending audio chunks
			// Safari doesn't support audio/webm — fall back to whatever is available
			const mimeType = MediaRecorder.isTypeSupported('audio/webm')
				? 'audio/webm'
				: MediaRecorder.isTypeSupported('audio/mp4')
					? 'audio/mp4'
					: undefined;

			mediaRecorder = new MediaRecorder(stream!, mimeType ? { mimeType } : {});

			mediaRecorder.ondataavailable = (event) => {
				if (event.data.size > 0 && socket?.readyState === WebSocket.OPEN) {
					socket.send(event.data);
				}
			};

			mediaRecorder.start(250); // Send chunks every 250ms
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
			if (event.code !== 1000 && event.code !== 1005) {
				errorCb?.(new Error(`Deepgram connection closed: ${event.code} ${event.reason}`));
			}
		};
	}

	function stop() {
		// Stop MediaRecorder
		if (mediaRecorder && mediaRecorder.state !== 'inactive') {
			mediaRecorder.stop();
		}
		mediaRecorder = null;

		// Send close signal to Deepgram
		if (socket && socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: 'CloseStream' }));
			socket.close();
		}
		socket = null;

		// Stop all audio tracks
		if (stream) {
			stream.getTracks().forEach((track) => track.stop());
		}
		stream = null;
	}

	return {
		start,
		stop,
		onTranscript(cb: TranscriptCallback) {
			transcriptCb = cb;
		},
		onError(cb: ErrorCallback) {
			errorCb = cb;
		}
	};
}

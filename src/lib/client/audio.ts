let audioContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let lastSpokenText: string = '';
let currentAbort: AbortController | null = null;

/**
 * Unlock AudioContext on iOS (must be called from a user gesture handler).
 * Creates a silent buffer and plays it to satisfy the autoplay policy.
 */
export async function unlockAudio(): Promise<void> {
	if (!audioContext) {
		audioContext = new AudioContext();
	}

	if (audioContext.state === 'suspended') {
		await audioContext.resume();
	}

	// Play a silent buffer to fully unlock on iOS
	const buffer = audioContext.createBuffer(1, 1, 22050);
	const source = audioContext.createBufferSource();
	source.buffer = buffer;
	source.connect(audioContext.destination);
	source.start(0);
}

/**
 * Fetch TTS audio from the server and play it.
 * Returns a promise that resolves when playback ends.
 */
export async function speak(text: string, voice?: string, speed?: number): Promise<void> {
	if (!audioContext) {
		audioContext = new AudioContext();
	}

	if (audioContext.state === 'suspended') {
		await audioContext.resume();
	}

	lastSpokenText = text;

	// Abort any in-flight TTS fetch
	if (currentAbort) {
		currentAbort.abort();
	}
	const abort = new AbortController();
	currentAbort = abort;

	const params: Record<string, string> = { text };
	if (voice) params.voice = voice;
	if (speed) params.speed = String(speed);

	const response = await fetch('/api/tts', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(params),
		signal: abort.signal
	});

	if (!response.ok) {
		throw new Error(`TTS failed: ${response.status}`);
	}

	// Check if cancelled during fetch
	if (abort.signal.aborted) return;

	const arrayBuffer = await response.arrayBuffer();
	const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

	// Check if cancelled during decode
	if (abort.signal.aborted) return;

	return new Promise<void>((resolve, reject) => {
		const source = audioContext!.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(audioContext!.destination);
		currentSource = source;

		source.onended = () => {
			currentSource = null;
			resolve();
		};

		try {
			source.start(0);
		} catch (err) {
			currentSource = null;
			reject(err);
		}
	});
}

/**
 * Stop the currently playing audio source.
 */
export function stopPlayback(): void {
	// Abort any in-flight TTS fetch
	if (currentAbort) {
		currentAbort.abort();
		currentAbort = null;
	}

	if (currentSource) {
		try {
			currentSource.stop();
		} catch {
			// Already stopped
		}
		currentSource = null;
	}
}

/**
 * Get the last spoken text (for "repeat" command support).
 */
export function getLastSpokenText(): string {
	return lastSpokenText;
}

/**
 * Play an audio file from a URL (e.g., chime sound).
 */
export async function playSound(url: string): Promise<void> {
	if (!audioContext) {
		audioContext = new AudioContext();
	}

	const response = await fetch(url);
	const arrayBuffer = await response.arrayBuffer();
	const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

	return new Promise<void>((resolve) => {
		const source = audioContext!.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(audioContext!.destination);
		source.onended = () => resolve();
		source.start(0);
	});
}

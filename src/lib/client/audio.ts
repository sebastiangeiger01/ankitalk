let audioContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let lastSpokenText: string = '';
let currentAbort: AbortController | null = null;

/** In-memory TTS audio cache for preloading */
const audioCache = new Map<string, AudioBuffer>();

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
 * Build a cache key from TTS parameters.
 */
function cacheKey(text: string, voice?: string, speed?: number): string {
	return `${text}|${voice ?? ''}|${speed ?? ''}`;
}

/**
 * Fetch and decode TTS audio, returning the AudioBuffer.
 */
async function fetchTTSBuffer(text: string, voice?: string, speed?: number, signal?: AbortSignal): Promise<AudioBuffer> {
	if (!audioContext) {
		audioContext = new AudioContext();
	}

	const params: Record<string, string> = { text };
	if (voice) params.voice = voice;
	if (speed) params.speed = String(speed);

	const response = await fetch('/api/tts', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(params),
		signal
	});

	if (!response.ok) {
		throw new Error(`TTS failed: ${response.status}`);
	}

	const arrayBuffer = await response.arrayBuffer();
	return await audioContext.decodeAudioData(arrayBuffer);
}

/**
 * Preload TTS audio into the cache (fire-and-forget).
 */
export function preloadTTS(text: string, voice?: string, speed?: number): void {
	const key = cacheKey(text, voice, speed);
	if (audioCache.has(key)) return;

	fetchTTSBuffer(text, voice, speed).then((buffer) => {
		audioCache.set(key, buffer);
	}).catch(() => {
		// Preload failures are silent
	});
}

/**
 * Clear the TTS audio cache.
 */
export function clearAudioCache(): void {
	audioCache.clear();
}

/**
 * Fetch TTS audio from the server and play it.
 * Returns a promise that resolves when playback ends.
 * @param onPlaybackStart - called right before audio playback begins (after fetch+decode)
 */
export async function speak(text: string, voice?: string, speed?: number, onPlaybackStart?: () => void): Promise<void> {
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

	const key = cacheKey(text, voice, speed);
	let audioBuffer: AudioBuffer;

	// Check cache first
	const cached = audioCache.get(key);
	if (cached) {
		audioBuffer = cached;
		audioCache.delete(key);
	} else {
		audioBuffer = await fetchTTSBuffer(text, voice, speed, abort.signal);
	}

	// Check if cancelled during fetch/decode
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
			onPlaybackStart?.();
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

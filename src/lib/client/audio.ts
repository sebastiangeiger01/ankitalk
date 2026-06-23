let audioContext: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let lastSpokenText: string = '';
let currentAbort: AbortController | null = null;
let keepAliveSource: AudioBufferSourceNode | null = null;

/** Raw TTS responses cached without touching Web Audio before the user's Start gesture. */
const audioCache = new Map<string, ArrayBuffer>();

/** TTS preloads that have started but have not populated the audio cache yet. */
const audioPreloads = new Map<string, Promise<ArrayBuffer>>();

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

	// Keep the context running until the first real audio plays. iOS re-suspends an idle
	// context during the cold-start gap (card fetch + mic-permission prompt) between this
	// gesture and the first card's TTS, and resume() outside a gesture silently no-ops — so
	// the very first playback of the session would otherwise be inaudible. An inaudible
	// looping buffer holds the context in the "running" state cheaply.
	startKeepAlive();
}

/**
 * Hold the AudioContext open with a silent looping buffer so it can't auto-suspend between
 * the unlock gesture and the first real playback. Idempotent and inaudible (zeroed buffer).
 */
function startKeepAlive(): void {
	if (!audioContext || keepAliveSource) return;
	const buffer = audioContext.createBuffer(1, audioContext.sampleRate, audioContext.sampleRate);
	const source = audioContext.createBufferSource();
	source.buffer = buffer; // all-zero samples → silent
	source.loop = true;
	source.connect(audioContext.destination);
	source.start(0);
	keepAliveSource = source;
}

/**
 * Build a cache key from TTS parameters.
 */
function cacheKey(text: string, voice?: string, speed?: number): string {
	return `${text}|${voice ?? ''}|${speed ?? ''}`;
}

/**
 * Fetch TTS bytes without creating or using an AudioContext.
 * Decoding is intentionally deferred until playback, after the user's Start gesture.
 */
async function fetchTTSAudio(text: string, voice?: string, speed?: number, signal?: AbortSignal): Promise<ArrayBuffer> {
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

	return await response.arrayBuffer();
}

/**
 * Preload TTS audio into the cache (fire-and-forget).
 */
export function preloadTTS(text: string, voice?: string, speed?: number): void {
	const key = cacheKey(text, voice, speed);
	if (audioCache.has(key) || audioPreloads.has(key)) return;

	const preload = fetchTTSAudio(text, voice, speed)
		.then((audio) => {
			audioCache.set(key, audio);
			return audio;
		})
		.finally(() => {
			if (audioPreloads.get(key) === preload) audioPreloads.delete(key);
		});
	audioPreloads.set(key, preload);
	preload.catch(() => {
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

	// Stop any currently playing audio and abort in-flight fetch BEFORE any await,
	// so interruptTTS() called during async operations (e.g. audioContext.resume) can
	// still cancel this invocation via the abort signal.
	if (currentSource) {
		try { currentSource.stop(audioContext ? audioContext.currentTime : 0); } catch { /* already stopped */ }
		try { currentSource.disconnect(); } catch { /* already disconnected */ }
		currentSource = null;
	}
	if (currentAbort) {
		currentAbort.abort();
	}
	const abort = new AbortController();
	currentAbort = abort;

	if (audioContext.state === 'suspended') {
		await audioContext.resume();
	}

	// If we were interrupted while waiting for resume, bail out.
	if (abort !== currentAbort || abort.signal.aborted) return;

	lastSpokenText = text;

	const key = cacheKey(text, voice, speed);
	let audioData: ArrayBuffer;

	// Check cache first
	const cached = audioCache.get(key);
	if (cached) {
		audioData = cached;
		audioCache.delete(key);
	} else {
		const preload = audioPreloads.get(key);
		if (preload) {
			try {
				audioData = await preload;
				audioCache.delete(key);
			} catch {
				// The speculative preload may fail independently. Retry as the requested playback.
				audioData = await fetchTTSAudio(text, voice, speed, abort.signal);
			}
		} else {
			audioData = await fetchTTSAudio(text, voice, speed, abort.signal);
		}
	}

	// Check if cancelled or superseded during fetch.
	if (abort !== currentAbort || abort.signal.aborted) return;

	// Decode only after unlockAudio() has created and resumed the context from Start.
	const audioBuffer = await audioContext.decodeAudioData(audioData.slice(0));

	// Check again because decoding is asynchronous.
	if (abort !== currentAbort || abort.signal.aborted) return;

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
			// Pass explicit time so iOS Safari stops immediately rather than at next quantum
			currentSource.stop(audioContext ? audioContext.currentTime : 0);
		} catch {
			// Already stopped
		}
		try {
			currentSource.disconnect();
		} catch {
			// Already disconnected
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

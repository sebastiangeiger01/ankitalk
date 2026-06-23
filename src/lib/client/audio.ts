let audioElement: HTMLAudioElement | null = null;
let lastSpokenText = '';
let currentAbort: AbortController | null = null;
let currentPlayback: { stop: () => void } | null = null;

/** MP3 responses cached without creating a playback object before the user's Start gesture. */
const audioCache = new Map<string, Blob>();

/** TTS requests that have started but have not populated the audio cache yet. */
const audioPreloads = new Map<string, Promise<Blob>>();

function getAudioElement(): HTMLAudioElement {
	if (!audioElement) {
		audioElement = new Audio();
		audioElement.preload = 'auto';
	}
	return audioElement;
}

function cacheKey(text: string, voice?: string, speed?: number): string {
	return `${text}|${voice ?? ''}|${speed ?? ''}`;
}

async function fetchTTSAudio(text: string, voice?: string, speed?: number, signal?: AbortSignal): Promise<Blob> {
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

	const audio = await response.blob();
	return audio.type ? audio : new Blob([audio], { type: 'audio/mpeg' });
}

/** Preload the ElevenLabs MP3 response and report whether it is ready for gesture playback. */
export function preloadTTS(text: string, voice?: string, speed?: number): Promise<boolean> {
	const key = cacheKey(text, voice, speed);
	if (audioCache.has(key)) return Promise.resolve(true);
	const existing = audioPreloads.get(key);
	if (existing) return existing.then(() => true, () => false);

	const preload = fetchTTSAudio(text, voice, speed)
		.then((audio) => {
			audioCache.set(key, audio);
			return audio;
		})
		.finally(() => {
			if (audioPreloads.get(key) === preload) audioPreloads.delete(key);
		});
	audioPreloads.set(key, preload);
	return preload.then(() => true, () => false);
}

export function clearAudioCache(): void {
	audioCache.clear();
}

function stopCurrentPlayback(): void {
	if (currentPlayback) {
		currentPlayback.stop();
		return;
	}
	audioElement?.pause();
}

function playSource(src: string, onPlaybackStart?: () => void, objectUrl?: string): Promise<void> {
	stopCurrentPlayback();
	const player = getAudioElement();
	player.src = src;
	player.load();

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let started = false;

		const cleanup = () => {
			player.removeEventListener('playing', handlePlaying);
			player.removeEventListener('ended', handleEnded);
			player.removeEventListener('error', handleError);
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (currentPlayback?.stop === stop) currentPlayback = null;
			if (error) reject(error);
			else resolve();
		};
		const stop = () => {
			player.pause();
			settle();
		};
		const handlePlaying = () => {
			if (started) return;
			started = true;
			onPlaybackStart?.();
		};
		const handleEnded = () => settle();
		const handleError = () => settle(new Error(`Audio playback failed${player.error ? ` (${player.error.code})` : ''}`));

		currentPlayback = { stop };
		player.addEventListener('playing', handlePlaying);
		player.addEventListener('ended', handleEnded);
		player.addEventListener('error', handleError);
		player.play().catch((error: unknown) => {
			settle(error instanceof Error ? error : new Error('Audio playback failed'));
		});
	});
}

/** Fetch ElevenLabs TTS and play it through the one iOS-authorized media element. */
export async function speak(text: string, voice?: string, speed?: number, onPlaybackStart?: () => void): Promise<void> {
	stopPlayback();
	const abort = new AbortController();
	currentAbort = abort;
	lastSpokenText = text;

	const key = cacheKey(text, voice, speed);
	let audio = audioCache.get(key);
	if (audio) {
		audioCache.delete(key);
	} else {
		const preload = audioPreloads.get(key);
		if (preload) {
			try {
				audio = await preload;
				audioCache.delete(key);
			} catch {
				if (abort.signal.aborted) return;
				audio = await fetchTTSAudio(text, voice, speed, abort.signal);
			}
		} else {
			audio = await fetchTTSAudio(text, voice, speed, abort.signal);
		}
	}

	if (abort !== currentAbort || abort.signal.aborted) return;

	const objectUrl = URL.createObjectURL(audio);
	try {
		await playSource(objectUrl, onPlaybackStart, objectUrl);
	} finally {
		if (currentAbort === abort) currentAbort = null;
	}
}

export function stopPlayback(): void {
	if (currentAbort) {
		currentAbort.abort();
		currentAbort = null;
	}
	stopCurrentPlayback();
}

export function getLastSpokenText(): string {
	return lastSpokenText;
}

/** Play chimes through the same authorized media element. */
export function playSound(url: string): Promise<void> {
	return playSource(url);
}

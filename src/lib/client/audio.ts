let audioElement: HTMLAudioElement | null = null;
let lastSpokenText = '';
let currentAbort: AbortController | null = null;
let currentPlayback: { stop: () => void } | null = null;
let audioUnlocked = false;

/**
 * 50 ms of 8-bit silence. Played once, synchronously, inside the Start button's gesture to
 * "bless" the shared media element on iOS Safari: after one gesture-initiated play() the
 * element may be driven programmatically (from a promise/timer) for the rest of the session.
 * This is what lets us stop gating Start on a finished TTS round trip — the first card can be
 * fetched after the click and still play, because the element is already unlocked.
 */
const SILENT_CLIP =
	'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

/**
 * Unlock the shared media element for programmatic playback on iOS. MUST be called from a
 * real user gesture (e.g. the Start button's click handler). Idempotent and a no-op after the
 * first successful call.
 */
export function unlockAudioForGesture(): void {
	if (audioUnlocked) return;
	audioUnlocked = true;
	const player = getAudioElement();
	try {
		player.src = SILENT_CLIP;
		const played = player.play();
		// Swallow the rejection a later real play() may cause by interrupting this silent clip.
		if (played && typeof played.catch === 'function') played.catch(() => {});
	} catch {
		// If even this throws the element is unusable; real playback will surface a clear error.
	}
}

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

function errorDetail(error: unknown): string {
	if (error && typeof error === 'object') {
		const value = error as { name?: unknown; message?: unknown };
		const name = typeof value.name === 'string' ? value.name : 'Error';
		const message = typeof value.message === 'string' ? value.message : '';
		return message ? `${name}: ${message}` : name;
	}
	return typeof error === 'string' ? error : 'unknown error';
}

async function fetchTTSAudio(text: string, voice?: string, speed?: number, signal?: AbortSignal, deckId?: string): Promise<Blob> {
	const params: Record<string, string> = { text };
	if (voice) params.voice = voice;
	if (speed) params.speed = String(speed);
	// deckId doesn't change the audio (so it's intentionally absent from the client cache key);
	// it only tells the server which deck's exam-pin retention this clip belongs to.
	if (deckId) params.deckId = deckId;

	let response: Response;
	try {
		response = await fetch('/api/tts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(params),
			signal
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new Error(`TTS request failed: ${errorDetail(error)}`);
	}

	if (!response.ok) {
		const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 180);
		throw new Error(`TTS HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
	}

	const audio = await response.blob();
	if (audio.size === 0) throw new Error('TTS returned an empty audio response');
	return audio.type ? audio : new Blob([audio], { type: 'audio/mpeg' });
}

/** Preload the ElevenLabs MP3 response and report whether it is ready for gesture playback. */
export function preloadTTS(text: string, voice?: string, speed?: number, deckId?: string): Promise<boolean> {
	const key = cacheKey(text, voice, speed);
	if (audioCache.has(key)) return Promise.resolve(true);
	const existing = audioPreloads.get(key);
	if (existing) return existing.then(() => true, () => false);

	const preload = fetchTTSAudio(text, voice, speed, undefined, deckId)
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

function mediaErrorName(code: number): string {
	return ({ 1: 'aborted', 2: 'network', 3: 'decode', 4: 'source-not-supported' } as Record<number, string>)[code] ?? 'unknown';
}

function mediaState(player: HTMLAudioElement): string {
	return `readyState=${player.readyState}, networkState=${player.networkState}`;
}

function playSource(src: string, onPlaybackStart?: () => void, objectUrl?: string, sourceInfo?: string): Promise<void> {
	stopCurrentPlayback();
	const player = getAudioElement();
	player.src = src;
	player.load();

	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let started = false;

		// Two watchdogs, NOT an absolute cap on playback length. `startTimer` guards the time
		// until audio actually begins (decode/autoplay problems). `stallTimer` is (re)armed on
		// every progress tick once playing, so it only fires if a *playing* clip wedges. A flat
		// timeout on the whole promise would cut off any card longer than the timeout.
		const START_TIMEOUT_MS = 10000;
		const STALL_TIMEOUT_MS = 10000;
		let startTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
			settle(new Error(`TTS playback failed to start (${sourceInfo ?? 'unknown source'}; ${mediaState(player)})`));
		}, START_TIMEOUT_MS);
		let stallTimer: ReturnType<typeof setTimeout> | null = null;

		const armStallTimer = () => {
			if (stallTimer) clearTimeout(stallTimer);
			stallTimer = setTimeout(() => {
				settle(new Error(`TTS playback stalled (${sourceInfo ?? 'unknown source'}; ${mediaState(player)})`));
			}, STALL_TIMEOUT_MS);
		};

		const cleanup = () => {
			if (startTimer) clearTimeout(startTimer);
			if (stallTimer) clearTimeout(stallTimer);
			player.removeEventListener('playing', handlePlaying);
			player.removeEventListener('timeupdate', handleProgress);
			player.removeEventListener('ended', handleEnded);
			player.removeEventListener('error', handleError);
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			// Never leave a failed clip audibly playing on the shared element.
			if (error) player.pause();
			if (currentPlayback?.stop === stop) currentPlayback = null;
			if (error) reject(error);
			else resolve();
		};
		const stop = () => {
			player.pause();
			settle();
		};
		const handlePlaying = () => {
			if (startTimer) {
				clearTimeout(startTimer);
				startTimer = null;
			}
			armStallTimer();
			if (started) return;
			started = true;
			onPlaybackStart?.();
		};
		const handleProgress = () => {
			if (started) armStallTimer();
		};
		const handleEnded = () => settle();
		const handleError = () => settle(new Error(
			`TTS media error: ${player.error ? `${mediaErrorName(player.error.code)} (${player.error.code})` : 'unknown'} (${sourceInfo ?? 'unknown source'}; ${mediaState(player)})`
		));

		currentPlayback = { stop };
		player.addEventListener('playing', handlePlaying);
		player.addEventListener('timeupdate', handleProgress);
		player.addEventListener('ended', handleEnded);
		player.addEventListener('error', handleError);
		player.play().catch((error: unknown) => {
			settle(new Error(`TTS play() rejected: ${errorDetail(error)} (${sourceInfo ?? 'unknown source'}; ${mediaState(player)})`));
		});
	});
}

/** Fetch ElevenLabs TTS and play it through the one iOS-authorized media element. */
export async function speak(text: string, voice?: string, speed?: number, onPlaybackStart?: () => void, deckId?: string): Promise<void> {
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
				// Deliberately NOT passing abort.signal — see the note in the `else` branch below.
				audio = await fetchTTSAudio(text, voice, speed, undefined, deckId);
			}
		} else {
			// Deliberately NOT passing abort.signal: aborting the *fetch* when the learner advances
			// or rates cancels the server handler mid-flight — AFTER ElevenLabs has been billed but
			// BEFORE the clip is written to R2 or logged — so we pay, never cache, and re-pay on the
			// next play. We still abort *playback* (the guard below skips a superseded clip), but we
			// let the request itself run to completion so every paid clip always gets cached.
			audio = await fetchTTSAudio(text, voice, speed, undefined, deckId);
		}
	}

	if (abort !== currentAbort || abort.signal.aborted) return;

	const mime = audio.type || 'audio/mpeg';
	const support = getAudioElement().canPlayType(mime);
	if (!support) throw new Error(`Safari reports unsupported TTS format: ${mime} (${audio.size} bytes)`);

	const objectUrl = URL.createObjectURL(audio);
	try {
		await playSource(objectUrl, onPlaybackStart, objectUrl, `${mime}, ${audio.size} bytes, canPlayType=${support}`);
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

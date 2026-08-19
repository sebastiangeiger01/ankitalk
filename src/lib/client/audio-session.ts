/**
 * iOS audio-session control (Safari 16.4+, `navigator.audioSession`).
 *
 * Safari's default session type is `auto`, which means "infer from what the page does".
 * The inference is per browsing context and sticky: once anything in the app has opened a
 * microphone (the review session does), the session stays in `play-and-record` for the rest
 * of the tab's life. In that mode iOS applies the voice-call processing chain to *output* —
 * acoustic echo cancellation plus ambient-noise ducking — so a purely playback screen like
 * the listen reader gets quieter whenever the room gets louder, and can even be routed to
 * the earpiece instead of the speaker.
 *
 * Declaring the type explicitly is the fix: `playback` for listen-only screens (full
 * volume, media routing, no AEC), `play-and-record` while the mic is genuinely in use.
 * Everything here is best-effort — non-Safari browsers have no `audioSession` and simply
 * keep their normal behaviour.
 */

export type AudioSessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';

interface AudioSessionLike {
	type: AudioSessionType;
}

function getAudioSession(): AudioSessionLike | null {
	if (typeof navigator === 'undefined') return null;
	const session = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
	return session && typeof session === 'object' ? session : null;
}

/** True when the platform exposes the audio-session API at all (iOS/macOS Safari). */
export function supportsAudioSession(): boolean {
	return getAudioSession() !== null;
}

/**
 * Set the audio-session type. Returns the previous value so a screen can restore whatever
 * it found on the way out, or null when the API is unavailable.
 */
export function setAudioSessionType(type: AudioSessionType): AudioSessionType | null {
	const session = getAudioSession();
	if (!session) return null;
	try {
		const previous = session.type;
		if (previous === type) return previous;
		session.type = type;
		return previous;
	} catch {
		// Some builds expose the object but reject unknown values — never let this break playback.
		return null;
	}
}

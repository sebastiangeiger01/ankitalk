/**
 * Run-ahead pacing for the listen stream.
 *
 * The stream endpoint synthesizes sentence after sentence into one long chunked MP3 response.
 * Left unthrottled it would race far ahead of the listener and bill ElevenLabs for minutes of
 * audio nobody hears after a pause; throttled too tightly the browser's buffer never grows and
 * playback stutters. These helpers define the middle ground.
 */

/** Client-side `audio.playbackRate` bounds. Mirrors the rates the player bar offers. */
export const MIN_PLAYBACK_RATE = 0.5;
export const MAX_PLAYBACK_RATE = 3;

/** Audio generated flat out before the throttle engages, so playback starts with a cushion. */
export const RUN_AHEAD_LEAD_MS = 30_000;

/** How many times faster than the listener the generator is allowed to run once throttled. */
export const RUN_AHEAD_FACTOR = 2;

/** Parse and clamp the `rate` query parameter; anything unusable means "normal speed". */
export function clampPlaybackRate(raw: string | null): number {
	const n = raw === null ? 1 : Number(raw);
	if (!Number.isFinite(n)) return 1;
	return Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, n));
}

/**
 * Wall-clock ms the generator is allowed to have spent once it has written `writtenMs` of audio.
 *
 * The previous rule was a flat `writtenMs / 2` — generate at 2× real time — which silently
 * assumed a 1× listener. At `playbackRate` 2× the browser drains the stream exactly as fast as
 * we fill it, so the buffer never builds and playback stalls every few sentences; at 1.5× it
 * survives only until one slow synthesis call. Pacing against the listener's actual rate keeps
 * the same 2× headroom at every speed.
 */
export function throttleTargetElapsedMs(writtenMs: number, playbackRate: number): number {
	const rate = Math.max(MIN_PLAYBACK_RATE, playbackRate);
	return Math.max(0, writtenMs - RUN_AHEAD_LEAD_MS) / (RUN_AHEAD_FACTOR * rate);
}

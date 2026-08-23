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

/**
 * How much audio the generator may stay ahead of the playhead.
 *
 * This is a *lead*, not a rate multiplier, and that distinction is the whole point. The
 * original rule — sleep `durationMs / 2`, i.e. generate at a flat 2× real time — bounds how
 * fast we run ahead but not how far: against a 1× listener the lead grows by one second per
 * second, so ten minutes in, ten extra minutes of audio (~9 MB) have been pushed into the
 * browser. That is bad three times over. It pre-bills ElevenLabs for audio a pause throws
 * away; it hands Safari a media buffer that grows without limit; and because the response
 * supports no Range requests, anything the browser evicts from that buffer can only be
 * recovered by refetching the URL from byte zero — which restarts the stream at its first
 * sentence, minutes behind where the listener actually was.
 *
 * A fixed lead keeps the buffer flat instead: enough cushion to absorb a slow synthesis call
 * or a brief network stall, never enough to accumulate.
 */
export const RUN_AHEAD_LEAD_MS = 90_000;

/** Parse and clamp the `rate` query parameter; anything unusable means "normal speed". */
export function clampPlaybackRate(raw: string | null): number {
	const n = raw === null ? 1 : Number(raw);
	if (!Number.isFinite(n)) return 1;
	return Math.max(MIN_PLAYBACK_RATE, Math.min(MAX_PLAYBACK_RATE, n));
}

/**
 * Wall-clock ms the generator is allowed to have spent once it has written `writtenMs` of
 * audio, so that it stays `RUN_AHEAD_LEAD_MS` ahead of the playhead and no further.
 *
 * A listener playing at `playbackRate` has consumed `elapsed * playbackRate` of audio after
 * `elapsed` of wall clock, so holding `writtenMs ≤ elapsed * rate + LEAD` is the same as
 * waiting until `elapsed ≥ (writtenMs − LEAD) / rate`. The lead is therefore generated flat
 * out at the start (playback begins with a full cushion) and maintained from then on, at any
 * playback speed — including 2×, where the previous flat-2× rule matched the listener exactly
 * and the buffer could never grow at all.
 */
export function throttleTargetElapsedMs(writtenMs: number, playbackRate: number): number {
	const rate = Math.max(MIN_PLAYBACK_RATE, playbackRate);
	return Math.max(0, writtenMs - RUN_AHEAD_LEAD_MS) / rate;
}

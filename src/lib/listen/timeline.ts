/**
 * Document-time arithmetic for the listen reader.
 *
 * Playback is a chunked MP3 stream that starts at some sentence, so the audio element's
 * `currentTime` is relative to *that* sentence, not to the document. Every position the user
 * sees or manipulates — the seek bar, the lock-screen scrubber, ±10s skips — is in document
 * time. These helpers convert between the two, using each sentence's duration (actual for
 * cached audio, estimated otherwise).
 */

export interface TimedSentence {
	duration_ms: number;
}

/** Total document duration in seconds. */
export function totalDurationSec(sentences: readonly TimedSentence[]): number {
	return sentences.reduce((sum, s) => sum + s.duration_ms, 0) / 1000;
}

/** Document-time offset (seconds) at which sentence `seq` starts. */
export function documentOffsetSec(sentences: readonly TimedSentence[], seq: number): number {
	let acc = 0;
	for (let i = 0; i < seq && i < sentences.length; i++) acc += sentences[i].duration_ms;
	return acc / 1000;
}

/**
 * Index of the sentence being spoken at document time `targetSec`. Clamps into range, so a
 * skip past either end lands on the first/last sentence instead of falling off.
 */
export function seqAtDocumentTime(sentences: readonly TimedSentence[], targetSec: number): number {
	if (!sentences.length) return 0;
	if (targetSec <= 0) return 0;
	let acc = 0;
	for (let i = 0; i < sentences.length; i++) {
		acc += sentences[i].duration_ms / 1000;
		if (targetSec < acc) return i;
	}
	return sentences.length - 1;
}

/** Clamp a document time into [0, total]. */
export function clampDocumentTime(sentences: readonly TimedSentence[], targetSec: number): number {
	const total = totalDurationSec(sentences);
	if (!Number.isFinite(targetSec)) return 0;
	return Math.max(0, Math.min(total, targetSec));
}

/**
 * Whether `t` (seconds, element-relative) can be seeked to without the browser refetching the
 * source. A live chunked stream reports `seekable` only over what it already holds; seeking
 * outside that makes Safari reload the URL, which for our endpoint means restarting playback
 * from the stream's first sentence. The margin keeps us off the very edge of the range, where
 * a seek lands on the boundary and immediately stalls.
 */
export function isSeekableTo(el: Pick<HTMLMediaElement, 'seekable' | 'buffered'>, t: number, marginSec = 0.25): boolean {
	const covers = (ranges: TimeRanges | undefined): boolean => {
		if (!ranges) return false;
		for (let i = 0; i < ranges.length; i++) {
			if (t >= ranges.start(i) && t <= ranges.end(i) - marginSec) return true;
		}
		return false;
	};
	try {
		return covers(el.seekable) && covers(el.buffered);
	} catch {
		return false;
	}
}

/**
 * Whether the media element's clock jumped backwards on its own.
 *
 * The listen stream carries no Range support, so a browser that loses or evicts part of it can
 * only recover by refetching the URL — which makes the server replay from the stream's first
 * sentence while `currentTime` restarts at zero. To the listener that is the whole session
 * snapping back to wherever they pressed play, several minutes ago, with no error anywhere.
 *
 * Distinguishing that from ordinary playback is easy, as long as the caller excludes the
 * position changes it asked for (a seek, a fresh stream): time only ever moves forward on its
 * own, so a large drop to near the start of the stream is a restart, not a rewind. The
 * thresholds keep small backwards wobbles — which some browsers emit around a stall — from
 * being mistaken for one.
 */
export function isUnrequestedRestart(
	previousSec: number,
	nextSec: number,
	{ minProgressSec = 20, restartWindowSec = 3 } = {}
): boolean {
	if (!Number.isFinite(previousSec) || !Number.isFinite(nextSec)) return false;
	return previousSec >= minProgressSec && nextSec <= restartWindowSec && nextSec < previousSec;
}

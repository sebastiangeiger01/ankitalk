export type TranscriptCallback = (transcript: string, isFinal: boolean) => void;
export type ErrorCallback = (error: Error) => void;

export interface SpeechClient {
	/**
	 * Start capturing. When `stream` is provided the client adopts it (and owns its
	 * lifecycle from then on) instead of calling getUserMedia itself — on iOS,
	 * stopping one mic stream and re-acquiring moments later can yield a muted
	 * second stream, so the caller acquires once and hands it through.
	 */
	start(stream?: MediaStream): Promise<void>;
	stop(): void;
	pause(): void;
	resume(): void;
	onTranscript(cb: TranscriptCallback): void;
	onError(cb: ErrorCallback): void;
	/**
	 * The live microphone MediaStream while capturing, or null when stopped/paused.
	 * Optional so lightweight test doubles don't need to implement it. Used by the review
	 * UI to drive the mic level meter — consumers must not stop the stream's tracks.
	 */
	getMediaStream?(): MediaStream | null;
}

export type TranscriptCallback = (transcript: string, isFinal: boolean) => void;
export type ErrorCallback = (error: Error) => void;

export interface SpeechClient {
	start(): Promise<void>;
	stop(): void;
	pause(): void;
	resume(): void;
	onTranscript(cb: TranscriptCallback): void;
	onError(cb: ErrorCallback): void;
}

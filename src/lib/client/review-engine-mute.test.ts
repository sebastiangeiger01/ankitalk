import { describe, expect, it, vi } from 'vitest';
import type { TranscriptCallback } from './speech';

const pending = new Promise<void>(() => {});
const speechMocks = vi.hoisted(() => ({
	transcriptCb: null as TranscriptCallback | null
}));

vi.mock('./audio', () => ({
	unlockAudio: vi.fn(() => pending),
	speak: vi.fn(() => Promise.resolve()),
	stopPlayback: vi.fn(),
	getLastSpokenText: vi.fn(() => ''),
	playSound: vi.fn(() => Promise.resolve()),
	preloadTTS: vi.fn(),
	clearAudioCache: vi.fn()
}));

vi.mock('./elevenlabs', () => ({
	createElevenLabsClient: () => ({
		start: () => pending,
		stop: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		onTranscript: (cb: TranscriptCallback) => {
			speechMocks.transcriptCb = cb;
		},
		onError: vi.fn()
	})
}));

vi.mock('./deepgram', () => ({
	createDeepgramClient: () => ({
		start: () => pending,
		stop: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		onTranscript: vi.fn(),
		onError: vi.fn()
	})
}));

describe('review engine mic mute', () => {
	it('drops transcripts that straggle in while the mic is muted', async () => {
		const { createReviewEngine } = await import('./review-engine');
		const engine = createReviewEngine();
		const transcripts: string[] = [];
		engine.onEvent((event) => {
			if (event.type === 'transcript') transcripts.push(event.text);
		});

		await engine.start('deck-1', {
			prefetchedCards: {
				deckName: 'Deck',
				cards: [{
					id: 'card-1',
					deck_id: 'deck-1',
					note_id: 'note-1',
					card_type: 'basic',
					ordinal: 0,
					fsrs_state: 0,
					fsrs_reps: 0,
					fsrs_lapses: 0,
					model_name: 'Basic',
					fields: JSON.stringify([
						{ name: 'Front', value: 'Question' },
						{ name: 'Back', value: 'Answer' }
					]),
					tags: '',
					front_template: null,
					back_template: null
				}]
			}
		});

		const cb = speechMocks.transcriptCb;
		expect(cb).not.toBeNull();

		cb!('heard live', false);
		expect(transcripts).toEqual(['heard live']);

		// Mute, then simulate a result Deepgram/ElevenLabs finalized from audio that
		// was streamed before the pause — it must not surface or rate anything.
		engine.toggleMic();
		cb!('straggler after mute', true);
		expect(transcripts).toEqual(['heard live']);

		// Unmuting lets live results through again.
		engine.toggleMic();
		cb!('back on', false);
		expect(transcripts).toEqual(['heard live', 'back on']);

		engine.destroy();
	});
});

import { describe, expect, it, vi } from 'vitest';

const pending = new Promise<void>(() => {});
const audioMocks = vi.hoisted(() => ({
	speak: vi.fn(() => Promise.reject(new Error('TTS diagnostic')))
}));

vi.mock('./audio', () => ({
	unlockAudio: vi.fn(() => pending),
	speak: audioMocks.speak,
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
		onTranscript: vi.fn(),
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

describe('review engine startup', () => {
	it('presents prefetched cards without waiting for audio or microphone startup', async () => {
		const { createReviewEngine } = await import('./review-engine');
		const engine = createReviewEngine();
		const events: string[] = [];
		const errors: string[] = [];
		engine.onEvent((event) => {
			events.push(event.type);
			if (event.type === 'error') errors.push(event.message);
		});

		const start = engine.start('deck-1', {
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

		expect(events).toContain('card_change');
		await start;
		await Promise.resolve();
		expect(errors).toContain('TTS diagnostic');
		engine.destroy();
	});
});

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
		// Queue counts are (re-)emitted on every card change so the progress bar stays live
		expect(events).toContain('counts');
		// The mocked speech client exposes no MediaStream — the getter degrades to null
		expect(engine.getMicStream()).toBeNull();
		await start;
		await Promise.resolve();
		expect(errors).toContain('TTS diagnostic');
		engine.destroy();
	});

	it('emits live queue counts that include the presented card', async () => {
		const { createReviewEngine } = await import('./review-engine');
		const engine = createReviewEngine();
		const countEvents: Array<{ new: number; learning: number; review: number }> = [];
		engine.onEvent((event) => {
			if (event.type === 'counts') countEvents.push(event.counts);
		});

		const makeCard = (id: string, state: number) => ({
			id,
			deck_id: 'deck-1',
			note_id: `note-${id}`,
			card_type: 'basic',
			ordinal: 0,
			fsrs_state: state,
			fsrs_reps: 0,
			fsrs_lapses: 0,
			model_name: 'Basic',
			fields: JSON.stringify([
				{ name: 'Front', value: `Q ${id}` },
				{ name: 'Back', value: `A ${id}` }
			]),
			tags: '',
			front_template: null,
			back_template: null
		});

		await engine.start('deck-1', {
			prefetchedCards: {
				deckName: 'Deck',
				counts: { new: 2, learning: 0, review: 1 },
				cards: [makeCard('c1', 0), makeCard('c2', 0), makeCard('c3', 2)]
			}
		});

		// First the server counts, then the queue-derived counts on the first card change —
		// both describe the same fetched set, so they agree.
		expect(countEvents[0]).toEqual({ new: 2, learning: 0, review: 1 });
		expect(countEvents[1]).toEqual({ new: 2, learning: 0, review: 1 });
		engine.destroy();
	});
});

import { speak, stopPlayback, getLastSpokenText, playSound, preloadTTS, clearAudioCache } from './audio';
import { createDeepgramClient } from './deepgram';
import { createElevenLabsClient } from './elevenlabs';
import type { SpeechClient } from './speech';
import { renderCard } from './card-renderer';
import { clientCardSanitizer } from './card-sanitize';
import { matchCommand } from '../commands';
import type { VoiceProvider } from '../voice';
import type { ReviewPhase, VoiceCommand, RatingName } from '../types';

export interface IntervalLabels {
	again: string;
	hard: string;
	good: string;
	easy: string;
}

export interface QueueCounts {
	new: number;
	learning: number;
	review: number;
}

export type ReviewEvent =
	| { type: 'phase_change'; phase: ReviewPhase }
	| {
			type: 'card_change';
			index: number;
			total: number;
			front: string;
			back: string;
			frontHtml: string;
			backHtml: string;
			cardState: 'new' | 'learning' | 'review';
			intervals: IntervalLabels;
			/** Extra fields exposed for downstream features (agent tutor, etc.). Optional so
			 * pre-existing consumers don't have to handle them. */
			cardId?: string;
			deckId?: string;
			tags?: string;
			reps?: number;
			lapses?: number;
	  }
	| { type: 'tts_loading' }
	| { type: 'speaking' }
	| { type: 'listening' }
	| { type: 'idle' }
	| { type: 'command'; command: VoiceCommand }
	| { type: 'transcript'; text: string; isFinal: boolean }
	| { type: 'session_end'; stats: SessionStats }
	| { type: 'error'; message: string }
	| { type: 'deck_info'; name: string }
	| { type: 'undo_available'; available: boolean }
	| { type: 'mic_change'; micOn: boolean }
	| { type: 'audio_change'; audioOn: boolean }
	| { type: 'learning_due'; waitMs: number }
	| { type: 'card_suspended'; cardId: string }
	| { type: 'counts'; counts: QueueCounts };

export interface SessionStats {
	cardsReviewed: number;
	ratings: Record<RatingName, number>;
	durationMs: number;
}

interface CardData {
	id: string;
	deck_id: string;
	note_id: string;
	card_type: string;
	ordinal: number;
	fsrs_state: number;
	fsrs_reps: number;
	fsrs_lapses: number;
	model_name: string;
	fields: string;
	tags: string;
	front_template: string | null;
	back_template: string | null;
	front: string;
	back: string;
	frontHtml: string;
	backHtml: string;
	intervals: IntervalLabels;
}

interface LearningEntry {
	card: CardData;
	dueAt: number; // timestamp ms
}

interface UndoInfo {
	rating: RatingName;
	card: CardData;
	/** If the card was added to the learning queue on this rating, we need to remove it on undo */
	addedToLearning: boolean;
}

type EventCallback = (event: ReviewEvent) => void;

export interface PrefetchedCards {
	cards: Record<string, unknown>[];
	deckName: string;
	counts?: QueueCounts;
}

export interface StartOptions {
	tags?: string;
	mode?: 'cram';
	cramState?: 'new' | 'learning' | 'review';
	prefetchedCards?: PrefetchedCards;
	prepareAudioAhead?: boolean;
	/** Language code for STT (e.g. 'en', 'de'). Defaults to 'multi'. */
	sttLanguage?: string;
	voiceProvider?: VoiceProvider;
}

export interface ReviewEngine {
	start(deckId: string, options?: StartOptions): Promise<void>;
	destroy(): void;
	onEvent(cb: EventCallback): void;
	executeCommand(command: VoiceCommand): void;
	toggleMic(): void;
	toggleAudio(): void;
	undo(): void;
}

/** FSRS states */
const STATE_NEW = 0;
const STATE_LEARNING = 1;
const STATE_REVIEW = 2;
const STATE_RELEARNING = 3;

/** Max intra-session interval: cards due within 30 min stay in learning queue */
const LEARNING_QUEUE_MAX_MS = 30 * 60 * 1000;

/** If the next learning card is ≤ this far away, wait for it instead of ending session */
const LEARNING_WAIT_THRESHOLD_MS = 30 * 1000;

/** Timeout for review API call */
const REVIEW_API_TIMEOUT_MS = 3000;

export function createReviewEngine(): ReviewEngine {
	let eventCb: EventCallback | null = null;
	let speechClient: SpeechClient | null = null;
	let phase: ReviewPhase = 'question';
	let startTime = 0;
	let cardStartTime = 0;
	let destroyed = false;
	let audioOn = true;
	let micOn = true;
	let isSpeaking = false;
	let speakGen = 0;
	let undoInfo: UndoInfo | null = null;
	let undoTimer: ReturnType<typeof setTimeout> | null = null;
	let learningTimer: ReturnType<typeof setTimeout> | null = null;
	let isCramMode = false;
	let ratingInFlight = false;
	let undoInFlight = false;
	let sessionFinished = false;
	let prepareAudioAhead = true;
	// The deck under review. Passed to TTS so the server can honour this deck's exam-pin retention.
	let activeDeckId: string | undefined;

	// Dual-queue architecture
	let reviewQueue: CardData[] = [];
	let learningQueue: LearningEntry[] = [];
	let studiedNoteIds: Set<string> = new Set();
	let currentCard: CardData | null = null;
	let cardsReviewedCount = 0;

	const stats: SessionStats = {
		cardsReviewed: 0,
		ratings: { again: 0, hard: 0, good: 0, easy: 0 },
		durationMs: 0
	};

	function emit(event: ReviewEvent) {
		if (!destroyed) eventCb?.(event);
	}

	/**
	 * Non-blocking TTS: fires speech in the background, emits tts_loading/speaking/listening.
	 */
	function speakText(text: string) {
		speakGen++;
		const gen = speakGen;

		if (!audioOn) {
			if (micOn) emit({ type: 'listening' });
			else emit({ type: 'idle' });
			return;
		}

		isSpeaking = true;
		emit({ type: 'tts_loading' });

		speak(text, undefined, undefined, () => {
			if (gen === speakGen) {
				emit({ type: 'speaking' });
			}
		}, activeDeckId)
			.then(() => {
				if (gen === speakGen) playSound('/listen.mp3').catch(() => {});
			})
			.catch((error: unknown) => {
				if (gen === speakGen && !destroyed) {
					emit({
						type: 'error',
						message: error instanceof Error ? error.message : 'TTS failed with an unknown error'
					});
				}
			})
			.finally(() => {
				if (gen === speakGen) {
					isSpeaking = false;
					if (!destroyed) {
						if (micOn) emit({ type: 'listening' });
						else emit({ type: 'idle' });
					}
				}
			});
	}

	function interruptTTS() {
		speakGen++;
		stopPlayback();
		isSpeaking = false;
	}

	function clearLearningTimer() {
		if (learningTimer) {
			clearTimeout(learningTimer);
			learningTimer = null;
		}
	}

	/**
	 * Pick the next card from the queues.
	 * Priority: learning queue (if due now) → review queue (skip siblings) → wait for learning → end
	 */
	function pickNextCard(): CardData | 'wait' | 'end' {
		const now = Date.now();

		// 1. Check learning queue for cards due now
		if (learningQueue.length > 0 && learningQueue[0].dueAt <= now) {
			const entry = learningQueue.shift()!;
			return entry.card;
		}

		// 2. Review queue — skip siblings of studied notes
		while (reviewQueue.length > 0) {
			const card = reviewQueue.shift()!;
			if (studiedNoteIds.has(card.note_id)) {
				continue; // skip sibling
			}
			return card;
		}

		// 3. If learning cards are pending and close, wait for them
		if (learningQueue.length > 0) {
			const waitMs = learningQueue[0].dueAt - now;
			if (waitMs <= LEARNING_WAIT_THRESHOLD_MS) {
				return 'wait';
			}
		}

		return 'end';
	}

	function presentCard() {
		if (sessionFinished) return;

		const result = pickNextCard();

		if (result === 'end') {
			endSession();
			return;
		}

		if (result === 'wait') {
			// Wait for next learning card
			const waitMs = learningQueue[0].dueAt - Date.now();
			scheduleNextLearningCard(waitMs);
			return;
		}

		currentCard = result;
		const cardState: 'new' | 'learning' | 'review' =
			currentCard.fsrs_state === STATE_NEW ? 'new' :
			currentCard.fsrs_state === STATE_REVIEW ? 'review' : 'learning';

		phase = 'question';
		cardStartTime = Date.now();
		cardsReviewedCount++;

		emit({
			type: 'card_change',
			index: cardsReviewedCount - 1,
			total: cardsReviewedCount,
			front: currentCard.front,
			back: currentCard.back,
			frontHtml: currentCard.frontHtml,
			backHtml: currentCard.backHtml,
			cardState,
			intervals: currentCard.intervals,
			cardId: currentCard.id,
			deckId: currentCard.deck_id,
			tags: currentCard.tags,
			reps: currentCard.fsrs_reps,
			lapses: currentCard.fsrs_lapses
		});
		emit({ type: 'phase_change', phase: 'question' });

		// Preload the answer audio while question is playing
		if (audioOn && prepareAudioAhead && currentCard.back) {
			preloadTTS(currentCard.back, undefined, undefined, activeDeckId);
		}

		speakText(currentCard.front);
	}

	function scheduleNextLearningCard(waitMs: number) {
		clearLearningTimer();
		emit({ type: 'learning_due', waitMs });

		learningTimer = setTimeout(() => {
			learningTimer = null;
			// Present the now-due learning card
			presentCard();
		}, waitMs);
	}

	function handleCommand(command: VoiceCommand) {
		if (sessionFinished && command !== 'stop') return;

		interruptTTS();
		clearLearningTimer();

		// Undo must be handled before clearUndo() wipes the undo info
		if (command === 'undo') {
			if (undoInfo) {
				emit({ type: 'command', command });
				void performUndo();
			}
			return;
		}

		clearUndo();

		emit({ type: 'command', command });

		if (!currentCard) return;

		switch (command) {
			case 'answer':
				phase = 'rating';
				emit({ type: 'phase_change', phase: 'rating' });
				// Preload next card's front while answer is playing
				if (audioOn && prepareAudioAhead && reviewQueue.length > 0) {
					preloadTTS(reviewQueue[0].front, undefined, undefined, activeDeckId);
				}
				speakText(currentCard.back);
				break;

			case 'hint':
				// The review page opens the phase-aware ElevenLabs tutor from the
				// command event. Keeping this in the engine switch preserves voice commands.
				break;

			case 'repeat': {
				const lastText = getLastSpokenText();
				if (lastText) {
					speakText(lastText);
				}
				break;
			}

			case 'again':
			case 'hard':
			case 'good':
			case 'easy': {
				if (phase !== 'rating') break;
				void submitRating(command);
				break;
			}

			case 'explain':
				// Handled by the review page's ElevenLabs tutor UI.
				break;

			case 'suspend':
				handleSuspend();
				break;

			case 'stop':
				endSession();
				break;
		}
	}

	function handleSuspend() {
		if (!currentCard) return;
		const cardId = currentCard.id;

		// Fire-and-forget suspend API call
		fetch(`/api/cards/${cardId}/suspend`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ suspended: true })
		}).catch(() => {});

		emit({ type: 'card_suspended', cardId });

		// Remove from learning queue if present
		const idx = learningQueue.findIndex((e) => e.card.id === cardId);
		if (idx !== -1) learningQueue.splice(idx, 1);

		presentCard();
	}

	async function submitRating(rating: RatingName) {
		if (!currentCard || ratingInFlight || sessionFinished) return;

		const card = currentCard;
		const durationMs = Date.now() - cardStartTime;

		// Submit to server and get fsrsState + dueAt back
		let addedToLearning = false;
		let leeched = false;

		ratingInFlight = true;
		let timeout: ReturnType<typeof setTimeout> | null = null;
		try {
			const controller = new AbortController();
			timeout = setTimeout(() => controller.abort(), REVIEW_API_TIMEOUT_MS);

			const res = await fetch(`/api/cards/${card.id}/review`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ rating, durationMs }),
				signal: controller.signal
			});
			clearTimeout(timeout);
			timeout = null;

			if (!res.ok) {
				throw new Error(`Review API failed: ${res.status}`);
			}

			const data = (await res.json()) as {
				reviewId: string;
				dueAt: string;
				fsrsState: number;
				leeched?: boolean;
			};

			if (sessionFinished || destroyed) return;

			stats.cardsReviewed++;
			stats.ratings[rating]++;
			studiedNoteIds.add(card.note_id);

			const newState = data.fsrsState;
			const dueAt = new Date(data.dueAt).getTime();
			const now = Date.now();
			leeched = Boolean(data.leeched);

			// If card is still learning/relearning and due within 30 min, add to learning queue
			// If leeched, emit suspended event and don't add to learning queue
			// In cram mode, skip learning queue insertion
			if (leeched) {
				emit({ type: 'card_suspended', cardId: card.id });
			} else if (
				!isCramMode &&
				(newState === STATE_LEARNING || newState === STATE_RELEARNING) &&
				dueAt - now < LEARNING_QUEUE_MAX_MS
			) {
				const updatedCard: CardData = { ...card, fsrs_state: newState };
				// Insert sorted by dueAt
				const insertIdx = learningQueue.findIndex((e) => e.dueAt > dueAt);
				const entry: LearningEntry = { card: updatedCard, dueAt };
				if (insertIdx === -1) {
					learningQueue.push(entry);
				} else {
					learningQueue.splice(insertIdx, 0, entry);
				}
				addedToLearning = true;
			}

			// Store undo info — stays available until next command (e.g. "show answer")
			undoInfo = { rating, card, addedToLearning };
			emit({ type: 'undo_available', available: true });

			playSound('/success.mp3').catch(() => {});
			presentCard();
		} catch {
			emit({ type: 'error', message: 'Failed to save review' });
			if (micOn) emit({ type: 'listening' });
			else emit({ type: 'idle' });
		} finally {
			if (timeout) clearTimeout(timeout);
			ratingInFlight = false;
		}
	}

	function clearUndo() {
		if (undoTimer) {
			clearTimeout(undoTimer);
			undoTimer = null;
		}
		if (undoInfo) {
			undoInfo = null;
			emit({ type: 'undo_available', available: false });
		}
	}

	async function performUndo() {
		if (!undoInfo || undoInFlight || sessionFinished) return;

		interruptTTS();
		clearLearningTimer();

		const { rating, card, addedToLearning } = undoInfo;

		undoInFlight = true;
		try {
			const res = await fetch(`/api/cards/${card.id}/review/undo`, { method: 'POST' });
			if (!res.ok) throw new Error(`Undo API failed: ${res.status}`);
		} catch {
			emit({ type: 'error', message: 'Failed to undo review' });
			if (micOn) emit({ type: 'listening' });
			else emit({ type: 'idle' });
			undoInFlight = false;
			return;
		}
		undoInFlight = false;

		// Revert stats
		stats.cardsReviewed = Math.max(0, stats.cardsReviewed - 1);
		stats.ratings[rating] = Math.max(0, stats.ratings[rating] - 1);
		cardsReviewedCount--;
		studiedNoteIds.delete(card.note_id);

		// Put the current card back at the front of the review queue
		if (currentCard && currentCard.id !== card.id) {
			reviewQueue.unshift(currentCard);
		}

		// Remove from learning queue if it was added
		if (addedToLearning) {
			const idx = learningQueue.findIndex((e) => e.card.id === card.id);
			if (idx !== -1) learningQueue.splice(idx, 1);
		}

		clearUndo();

		// Re-present the undone card in rating phase
		currentCard = card;
		phase = 'rating';
		cardStartTime = Date.now();
		cardsReviewedCount++;

		const cardState: 'new' | 'learning' | 'review' =
			card.fsrs_state === STATE_NEW ? 'new' :
			card.fsrs_state === STATE_REVIEW ? 'review' : 'learning';

		emit({
			type: 'card_change',
			index: cardsReviewedCount - 1,
			total: cardsReviewedCount,
			front: card.front,
			back: card.back,
			frontHtml: card.frontHtml,
			backHtml: card.backHtml,
			cardState,
			intervals: card.intervals,
			cardId: card.id,
			deckId: card.deck_id,
			tags: card.tags,
			reps: card.fsrs_reps,
			lapses: card.fsrs_lapses
		});
		emit({ type: 'phase_change', phase: 'rating' });

		if (micOn) emit({ type: 'listening' });
		else emit({ type: 'idle' });
	}

	function endSession() {
		if (sessionFinished) return;
		sessionFinished = true;
		interruptTTS();
		clearUndo();
		clearLearningTimer();
		ratingInFlight = false;
		undoInFlight = false;
		stats.durationMs = Date.now() - startTime;
		speechClient?.stop();
		playSound('/complete.mp3').catch(() => {});
		emit({ type: 'session_end', stats });
	}

	async function start(deckId: string, options?: StartOptions) {
		destroyed = false;
		sessionFinished = false;
		activeDeckId = deckId;
		prepareAudioAhead = options?.prepareAudioAhead ?? true;
		startTime = Date.now();
		isCramMode = options?.mode === 'cram';

		// Microphone setup is optional and must not block cards.
		try {
			const client = options?.voiceProvider === 'openai_deepgram'
				? createDeepgramClient({ language: options?.sttLanguage })
				: createElevenLabsClient({ language: options?.sttLanguage });
			speechClient = client;
			client.onTranscript((transcript, isFinal) => {
				emit({ type: 'transcript', text: transcript, isFinal });

				if (isFinal) {
					const command = matchCommand(transcript, phase);
					if (command) handleCommand(command);
				}
			});
			client.onError((err) => {
				emit({ type: 'error', message: err.message });
			});
			void client.start().catch((err: unknown) => {
				if (destroyed || sessionFinished || speechClient !== client) return;
				client.stop();
				micOn = false;
				emit({ type: 'mic_change', micOn: false });
				emit({
					type: 'error',
					message: `Microphone error: ${err instanceof Error ? err.message : 'Unknown'}`
				});
			});
		} catch (err) {
			speechClient = null;
			micOn = false;
			emit({ type: 'mic_change', micOn: false });
			emit({
				type: 'error',
				message: `Microphone error: ${err instanceof Error ? err.message : 'Unknown'}`
			});
		}

		// Keep the prefetched path synchronous so the first card's preloaded MP3 starts
		// inside the Start button's user-gesture call stack on iOS.
		let data: PrefetchedCards;
		if (options?.prefetchedCards) {
			data = options.prefetchedCards;
		} else {
			try {
				const params = new URLSearchParams({ deckId, limit: '50' });
				if (options?.tags) params.set('tags', options.tags);
				if (options?.mode) params.set('mode', options.mode);
				if (options?.cramState) params.set('cramState', options.cramState);
				const res = await fetch(`/api/cards/next?${params}`);
				if (!res.ok) throw new Error('Failed to fetch cards');
				data = (await res.json()) as PrefetchedCards;
			} catch {
			speechClient?.stop();
			sessionFinished = true;
			emit({ type: 'error', message: 'Failed to fetch cards' });
			throw new Error('Failed to fetch cards');
			}
		}
		if (data.deckName) {
			emit({ type: 'deck_info', name: data.deckName });
		}
		if (data.counts) {
			emit({ type: 'counts', counts: data.counts });
		}
		if (!data.cards || data.cards.length === 0) {
			speechClient?.stop();
			sessionFinished = true;
			emit({ type: 'session_end', stats });
			return;
		}

		// Parse card fronts/backs into review queue
		const defaultIntervals: IntervalLabels = { again: '', hard: '', good: '', easy: '' };
		reviewQueue = data.cards.map((c) => {
			const { front, back, frontHtml, backHtml } = renderCard(
				c.fields as string,
				c.card_type as string,
				(c.ordinal as number) ?? 0,
				(c.front_template as string | null) ?? null,
				(c.back_template as string | null) ?? null,
				clientCardSanitizer
			);
			const intervals = (c.intervals as IntervalLabels) ?? defaultIntervals;
			return {
				id: c.id as string,
				deck_id: (c.deck_id as string) ?? '',
				note_id: c.note_id as string,
				card_type: c.card_type as string,
				ordinal: (c.ordinal as number) ?? 0,
				fsrs_state: c.fsrs_state as number,
				fsrs_reps: (c.fsrs_reps as number) ?? 0,
				fsrs_lapses: (c.fsrs_lapses as number) ?? 0,
				model_name: c.model_name as string,
				fields: c.fields as string,
				tags: c.tags as string,
				front_template: (c.front_template as string | null) ?? null,
				back_template: (c.back_template as string | null) ?? null,
				front,
				back,
				frontHtml,
				backHtml,
				intervals
			};
		});
		learningQueue = [];
		studiedNoteIds = new Set();
		currentCard = null;
		cardsReviewedCount = 0;

		// 3. Present first card immediately (speech recognition is already running)
		presentCard();
	}

	function destroy() {
		destroyed = true;
		sessionFinished = true;
		clearUndo();
		clearLearningTimer();
		stopPlayback();
		clearAudioCache();
		speechClient?.stop();
	}

	function toggleMic() {
		micOn = !micOn;
		if (micOn) {
			speechClient?.resume();
		} else {
			speechClient?.pause();
		}
		emit({ type: 'mic_change', micOn });
	}

	function toggleAudio() {
		audioOn = !audioOn;
		if (!audioOn) {
			interruptTTS();
		}
		emit({ type: 'audio_change', audioOn });
	}

	return {
		start(deckId: string, options?: StartOptions) {
			return start(deckId, options);
		},
		destroy,
		onEvent(cb: EventCallback) {
			eventCb = cb;
		},
		executeCommand(command: VoiceCommand) {
			handleCommand(command);
		},
		toggleMic,
		toggleAudio,
		undo() {
			performUndo();
		}
	};
}

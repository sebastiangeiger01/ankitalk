import { speak, stopPlayback, getLastSpokenText, playSound, preloadTTS, clearAudioCache } from './audio';
import { createDeepgramClient } from './deepgram';
import { createElevenLabsClient } from './elevenlabs';
import type { SpeechClient } from './speech';
import { renderCard } from './card-renderer';
import { clientCardSanitizer } from './card-sanitize';
import { matchCommand } from '../commands';
import type { SttProvider } from '../voice';
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
			/** Labeled fields the front/back don't display (Source, Back Extra, …). */
			extrasHtml?: string;
			/** Raw note fields JSON, for the in-review card editor. */
			fields?: string;
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
	extrasHtml: string;
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
	sttProvider?: SttProvider;
	/** Start the session with the microphone muted (STT stays untouched until unmuted). */
	micOn?: boolean;
	/** Start the session with card audio muted. */
	audioOn?: boolean;
	/**
	 * A mic stream already acquired inside the Start tap (for the permission fix).
	 * Handed to the STT client instead of re-acquiring: on iOS, a second getUserMedia
	 * right after stopping the first can come up muted — the recorder then sends no
	 * audio and Deepgram closes the socket (net0001). The engine owns it from here.
	 */
	micStream?: MediaStream;
}

export interface ReviewEngine {
	start(deckId: string, options?: StartOptions): Promise<void>;
	destroy(): void;
	onEvent(cb: EventCallback): void;
	executeCommand(command: VoiceCommand): void;
	toggleMic(): void;
	toggleAudio(): void;
	/**
	 * Stop any in-flight card audio without changing the audioOn setting — used when
	 * the tutor opens so the card voice doesn't talk over the conversation.
	 */
	interruptSpeech(): void;
	/**
	 * Apply an in-review note edit: re-render the current card (and any queued sibling
	 * cards of the same note) from the new fields and re-emit card_change so the display
	 * updates in place. Does not replay audio; "repeat" reads the edited text.
	 */
	updateCurrentCard(fieldsJson: string, tags: string): void;
	undo(): void;
	/**
	 * The live STT microphone stream, when the speech client exposes one. Used by the UI
	 * to drive a level meter; returns null when the mic is unavailable or paused.
	 */
	getMicStream(): MediaStream | null;
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

/**
 * Timeout for the review API call. Generous: the write happens in the background
 * (the UI has already advanced), and aborting a write the server may have committed
 * would produce a phantom "failed to save" for a rating that actually saved.
 */
const REVIEW_API_TIMEOUT_MS = 10000;

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
	// Whether speechClient.start() has run for this session. Starting muted skips it
	// entirely (no getUserMedia, no socket), so the first unmute must start — not
	// resume — the client (Deepgram's resume() is a no-op without a live socket).
	let speechStarted = false;
	let ratingInFlight = false;
	// Review writes are chained so rapid ratings reach the server in card order, and
	// stamped with a session generation so a write landing after "Review again" can't
	// reconcile into (or roll back) the wrong session.
	let pendingReview: Promise<unknown> = Promise.resolve();
	let sessionGen = 0;
	let undoInFlight = false;
	let sessionFinished = false;
	let prepareAudioAhead = true;
	// The deck under review. Passed to TTS so the server can honour this deck's exam-pin retention.
	let activeDeckId: string | undefined;
	// How many upcoming card fronts to warm at session start (bounded, just-in-time).
	const WARM_AHEAD_COUNT = 3;

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

	function stateBucket(state: number): keyof QueueCounts {
		if (state === STATE_NEW) return 'new';
		if (state === STATE_REVIEW) return 'review';
		return 'learning';
	}

	/**
	 * Remaining queue counts, including the card currently on screen. Emitted on every card
	 * change so the top-bar counts and the session progress bar stay live as queues drain.
	 * Matches the server's initial counts: both count the fetched card set per FSRS state.
	 */
	function computeCounts(): QueueCounts {
		const counts: QueueCounts = { new: 0, learning: 0, review: 0 };
		if (currentCard) counts[stateBucket(currentCard.fsrs_state)]++;
		for (const card of reviewQueue) {
			if (studiedNoteIds.has(card.note_id)) continue; // sibling — will be skipped
			counts[stateBucket(card.fsrs_state)]++;
		}
		for (const entry of learningQueue) counts[stateBucket(entry.card.fsrs_state)]++;
		return counts;
	}

	function presentCard() {
		if (sessionFinished) return;

		const result = pickNextCard();

		if (result === 'end') {
			endSession();
			return;
		}

		if (result === 'wait') {
			// Wait for next learning card. Clear the current card so commands arriving
			// during the hold can't act on the just-rated card (e.g. re-rate it).
			currentCard = null;
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
			lapses: currentCard.fsrs_lapses,
			extrasHtml: currentCard.extrasHtml,
			fields: currentCard.fields
		});
		emit({ type: 'counts', counts: computeCounts() });
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

		// Undo must be handled before clearUndo() wipes the undo info. It works during
		// the learning hold too (performUndo clears the hold timer itself).
		if (command === 'undo') {
			if (undoInfo) {
				emit({ type: 'command', command });
				void performUndo();
			}
			return;
		}

		// Stop must work even during the learning hold, when no card is current.
		if (command === 'stop') {
			emit({ type: 'command', command });
			endSession();
			return;
		}

		// No current card means we're in the learning hold: ignore everything else so a
		// stray key or transcript can't re-rate the just-rated card or, by falling
		// through, kill the hold timer and strand the session.
		if (!currentCard) return;

		clearUndo();

		emit({ type: 'command', command });

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
				submitRating(command);
				break;
			}

			case 'explain':
				// Handled by the review page's ElevenLabs tutor UI.
				break;

			case 'suspend':
				handleSuspend();
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

	/** Is another card presentable right now (without waiting or ending)? */
	function hasImmediateNextCard(): boolean {
		if (learningQueue.length > 0 && learningQueue[0].dueAt <= Date.now()) return true;
		return reviewQueue.some((c) => !studiedNoteIds.has(c.note_id));
	}

	/**
	 * Rating advances the UI immediately: the next card's front is already preloaded,
	 * so all the old `await` bought was a silent, frozen gap of one network round trip
	 * per card. The write runs in the background and is reconciled when it lands
	 * (learning re-queue, leech suspend, undo availability). Only when no next card is
	 * immediately presentable does the submit stay blocking, because the end-vs-hold
	 * decision depends on whether this rating re-queues the card for learning.
	 */
	function submitRating(rating: RatingName) {
		if (!currentCard || ratingInFlight || sessionFinished) return;

		const card = currentCard;
		const durationMs = Date.now() - cardStartTime;
		const gen = sessionGen;

		// Optimistic bookkeeping — postReview rolls it back if the write fails.
		stats.cardsReviewed++;
		stats.ratings[rating]++;
		studiedNoteIds.add(card.note_id);

		const write = () => postReview(card, rating, durationMs, gen);

		if (hasImmediateNextCard()) {
			pendingReview = pendingReview.then(write);
			playSound('/success.mp3').catch(() => {});
			presentCard();
			return;
		}

		// Last presentable card: wait for the authoritative result before deciding
		// between session end and the learning hold.
		ratingInFlight = true;
		pendingReview = pendingReview.then(write).then((ok) => {
			ratingInFlight = false;
			if (gen !== sessionGen || sessionFinished || destroyed) return;
			if (!ok) {
				// Rolled back: stay on the card in rating phase so the user can retry.
				if (micOn) emit({ type: 'listening' });
				else emit({ type: 'idle' });
				return;
			}
			playSound('/success.mp3').catch(() => {});
			presentCard();
		});
	}

	/**
	 * Background half of a rating: POST to the server, then reconcile the session with
	 * the authoritative result. Returns false — after rolling back the optimistic
	 * bookkeeping — when the write failed; the card then simply stays due server-side.
	 */
	async function postReview(
		card: CardData,
		rating: RatingName,
		durationMs: number,
		gen: number
	): Promise<boolean> {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), REVIEW_API_TIMEOUT_MS);
			let res: Response;
			try {
				res = await fetch(`/api/cards/${card.id}/review`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ rating, durationMs }),
					signal: controller.signal
				});
			} finally {
				clearTimeout(timeout);
			}

			if (!res.ok) {
				throw new Error(`Review API failed: ${res.status}`);
			}

			const data = (await res.json()) as {
				reviewId: string;
				dueAt: string;
				fsrsState: number;
				leeched?: boolean;
			};

			// Committed server-side, but a newer session owns the queues now.
			if (gen !== sessionGen || destroyed) return true;

			const newState = data.fsrsState;
			const dueAt = new Date(data.dueAt).getTime();
			let addedToLearning = false;

			// If card is still learning/relearning and due within 30 min, add to learning queue
			// If leeched, emit suspended event and don't add to learning queue
			// In cram mode, skip learning queue insertion
			if (data.leeched) {
				emit({ type: 'card_suspended', cardId: card.id });
			} else if (
				!isCramMode &&
				!sessionFinished &&
				(newState === STATE_LEARNING || newState === STATE_RELEARNING) &&
				dueAt - Date.now() < LEARNING_QUEUE_MAX_MS
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
				emit({ type: 'counts', counts: computeCounts() });
				// If we're holding for a learning card, this entry may be due sooner than
				// the one the hold timer was armed for — re-evaluate the hold.
				if (!currentCard && learningTimer) {
					clearLearningTimer();
					presentCard();
				}
			}

			if (sessionFinished) return true;

			// Store undo info — stays available until next command (e.g. "show answer")
			undoInfo = { rating, card, addedToLearning };
			emit({ type: 'undo_available', available: true });
			return true;
		} catch {
			if (gen !== sessionGen || destroyed) return false;
			// The server never saw this rating: roll back the optimistic bookkeeping.
			// The card stays due and comes back next session; siblings unblock again.
			stats.cardsReviewed = Math.max(0, stats.cardsReviewed - 1);
			stats.ratings[rating] = Math.max(0, stats.ratings[rating] - 1);
			studiedNoteIds.delete(card.note_id);
			if (!sessionFinished) {
				emit({ type: 'error', message: 'Failed to save review — the card stays due' });
			}
			return false;
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
			lapses: card.fsrs_lapses,
			extrasHtml: card.extrasHtml,
			fields: card.fields
		});
		emit({ type: 'counts', counts: computeCounts() });
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

	function startListening(client: SpeechClient, micStream?: MediaStream) {
		speechStarted = true;
		void client.start(micStream).catch((err: unknown) => {
			if (destroyed || sessionFinished || speechClient !== client) return;
			client.stop();
			micOn = false;
			emit({ type: 'mic_change', micOn: false });
			emit({
				type: 'error',
				message: `Microphone error: ${err instanceof Error ? err.message : 'Unknown'}`
			});
		});
	}

	async function start(deckId: string, options?: StartOptions) {
		destroyed = false;
		sessionFinished = false;
		sessionGen++;
		activeDeckId = deckId;
		prepareAudioAhead = options?.prepareAudioAhead ?? true;
		micOn = options?.micOn ?? true;
		audioOn = options?.audioOn ?? true;
		speechStarted = false;
		startTime = Date.now();
		isCramMode = options?.mode === 'cram';

		// Reset session stats so the same engine can run back-to-back sessions
		// (the summary screen's "Review again") without carrying over totals.
		stats.cardsReviewed = 0;
		stats.ratings = { again: 0, hard: 0, good: 0, easy: 0 };
		stats.durationMs = 0;

		// Microphone setup is optional and must not block cards.
		try {
			const client = options?.sttProvider === 'deepgram'
				? createDeepgramClient({ language: options?.sttLanguage })
				: createElevenLabsClient({ language: options?.sttLanguage });
			speechClient = client;
			client.onTranscript((transcript, isFinal) => {
				// Results can straggle in after a mute: pause() keeps the socket open
				// (Deepgram even KeepAlives it) and audio streamed before the pause may
				// finalize afterwards. A muted mic must neither caption nor rate cards.
				if (!micOn) return;
				emit({ type: 'transcript', text: transcript, isFinal });

				if (isFinal) {
					const command = matchCommand(transcript, phase);
					if (command) handleCommand(command);
				}
			});
			client.onError((err) => {
				emit({ type: 'error', message: err.message });
			});
			if (micOn) startListening(client, options?.micStream);
			else options?.micStream?.getTracks().forEach((track) => track.stop());
		} catch (err) {
			// The client never adopted the handed-in stream — release it here so the
			// browser's mic indicator doesn't stay lit on a failed setup.
			options?.micStream?.getTracks().forEach((track) => track.stop());
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
			// Let any in-flight review write land before fetching what's due ("Review
			// again" reaches this path), so a card rated at the very end of the previous
			// session can't come straight back into the new queue.
			await pendingReview;
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
			const { front, back, frontHtml, backHtml, extrasHtml } = renderCard(
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
				extrasHtml,
				intervals
			};
		});
		learningQueue = [];
		studiedNoteIds = new Set();
		currentCard = null;
		cardsReviewedCount = 0;

		// Just-in-time warm: kick off synthesis for the next few due cards so playback stays
		// instant and the provider calls are batched. Bounded — we never pre-generate a whole deck,
		// so cards the learner never reaches are never synthesized (and never charged for).
		warmUpcomingAudio();

		// 3. Present first card immediately (speech recognition is already running)
		presentCard();
	}

	function warmUpcomingAudio() {
		if (!audioOn || !prepareAudioAhead) return;
		for (const card of reviewQueue.slice(0, WARM_AHEAD_COUNT)) {
			if (card.front) void preloadTTS(card.front, undefined, undefined, activeDeckId);
		}
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
			if (speechClient && !speechStarted) startListening(speechClient);
			else speechClient?.resume();
		} else {
			speechClient?.pause();
		}
		// Keep the status indicator honest (the mic meter keys off 'listening'), but
		// never stomp an active TTS ('speaking' resolves itself) or the learning hold
		// ('waiting' has no current card).
		if (!isSpeaking && currentCard) {
			emit({ type: micOn ? 'listening' : 'idle' });
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

	function interruptSpeech() {
		// Bumping the speak generation (via interruptTTS) also suppresses the stopped
		// clip's finish chime and its trailing listening/idle emit.
		interruptTTS();
		if (destroyed || sessionFinished) return;
		if (micOn) emit({ type: 'listening' });
		else emit({ type: 'idle' });
	}

	function applyNoteEdit(card: CardData, fieldsJson: string, tags: string) {
		const rendered = renderCard(
			fieldsJson,
			card.card_type,
			card.ordinal,
			card.front_template,
			card.back_template,
			clientCardSanitizer
		);
		card.fields = fieldsJson;
		card.tags = tags;
		card.front = rendered.front;
		card.back = rendered.back;
		card.frontHtml = rendered.frontHtml;
		card.backHtml = rendered.backHtml;
		card.extrasHtml = rendered.extrasHtml;
	}

	function updateCurrentCard(fieldsJson: string, tags: string) {
		if (!currentCard || sessionFinished) return;

		// The edit is note-level: sibling cards of the same note waiting in the queues
		// (and a pending undo target) would otherwise present stale content.
		const noteId = currentCard.note_id;
		applyNoteEdit(currentCard, fieldsJson, tags);
		for (const card of reviewQueue) {
			if (card.note_id === noteId) applyNoteEdit(card, fieldsJson, tags);
		}
		for (const entry of learningQueue) {
			if (entry.card.note_id === noteId) applyNoteEdit(entry.card, fieldsJson, tags);
		}
		if (undoInfo && undoInfo.card.note_id === noteId) {
			applyNoteEdit(undoInfo.card, fieldsJson, tags);
		}

		// Re-emit the same card index so the display refreshes in place; the phase is
		// untouched and nothing is spoken (the user just read the text while editing it).
		const cardState: 'new' | 'learning' | 'review' =
			currentCard.fsrs_state === STATE_NEW ? 'new' :
			currentCard.fsrs_state === STATE_REVIEW ? 'review' : 'learning';
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
			lapses: currentCard.fsrs_lapses,
			extrasHtml: currentCard.extrasHtml,
			fields: currentCard.fields
		});
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
		interruptSpeech,
		updateCurrentCard,
		undo() {
			performUndo();
		},
		getMicStream() {
			return speechClient?.getMediaStream?.() ?? null;
		}
	};
}

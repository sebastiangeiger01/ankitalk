import { speak, stopPlayback, getLastSpokenText, unlockAudio, playSound } from './audio';
import { createDeepgramClient, type DeepgramClient } from './deepgram';
import { matchCommand } from '../commands';
import type { ReviewPhase, VoiceCommand, RatingName, NoteField } from '../types';

export type ReviewEvent =
	| { type: 'phase_change'; phase: ReviewPhase }
	| {
			type: 'card_change';
			index: number;
			total: number;
			front: string;
			back: string;
			isLearning: boolean;
	  }
	| { type: 'speaking' }
	| { type: 'listening' }
	| { type: 'idle' }
	| { type: 'command'; command: VoiceCommand }
	| { type: 'transcript'; text: string; isFinal: boolean }
	| { type: 'session_end'; stats: SessionStats }
	| { type: 'error'; message: string }
	| { type: 'explaining' }
	| { type: 'deck_info'; name: string }
	| { type: 'undo_available'; available: boolean }
	| { type: 'mic_change'; micOn: boolean }
	| { type: 'audio_change'; audioOn: boolean }
	| { type: 'learning_due'; waitMs: number }
	| { type: 'card_suspended'; cardId: string };

export interface SessionStats {
	cardsReviewed: number;
	ratings: Record<RatingName, number>;
	durationMs: number;
}

interface CardData {
	id: string;
	note_id: string;
	card_type: string;
	fsrs_state: number;
	model_name: string;
	fields: string;
	tags: string;
	front: string;
	back: string;
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

export interface StartOptions {
	tags?: string;
	mode?: 'cram';
	cramState?: 'new' | 'learning' | 'review';
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

/**
 * Strip HTML tags and decode entities for TTS.
 */
function stripHtml(html: string): string {
	const div = document.createElement('div');
	div.innerHTML = html;
	return div.textContent ?? '';
}

/**
 * Handle cloze deletions: {{c1::answer::hint}} → "blank" for question, "answer" for answer.
 */
function processCloze(text: string, showAnswer: boolean): string {
	return text.replace(/\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g, (_match, answer, hint) => {
		if (showAnswer) return answer;
		return hint || 'blank';
	});
}

/**
 * Parse card fields and extract front/back text for TTS.
 */
function renderCard(fieldsJson: string, cardType: string): { front: string; back: string } {
	let fields: NoteField[];
	try {
		fields = JSON.parse(fieldsJson);
	} catch {
		return { front: 'Error reading card', back: '' };
	}

	if (fields.length === 0) {
		return { front: 'Empty card', back: '' };
	}

	if (cardType === 'cloze') {
		const text = fields[0]?.value ?? '';
		return {
			front: stripHtml(processCloze(text, false)),
			back: stripHtml(processCloze(text, true))
		};
	}

	// Basic card: first field = front, second field = back
	const front = stripHtml(fields[0]?.value ?? '');
	const back = stripHtml(fields[1]?.value ?? front);
	return { front, back };
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
	let deepgram: DeepgramClient | null = null;
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
	 * Non-blocking TTS: fires speech in the background, emits speaking/listening.
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
		emit({ type: 'speaking' });

		speak(text)
			.then(() => {
				if (gen === speakGen) playSound('/listen.mp3').catch(() => {});
			})
			.catch(() => {})
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
		const isLearning =
			currentCard.fsrs_state === STATE_LEARNING ||
			currentCard.fsrs_state === STATE_RELEARNING;

		phase = 'question';
		cardStartTime = Date.now();
		cardsReviewedCount++;

		emit({
			type: 'card_change',
			index: cardsReviewedCount - 1,
			total: cardsReviewedCount,
			front: currentCard.front,
			back: currentCard.back,
			isLearning
		});
		emit({ type: 'phase_change', phase: 'question' });

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
		interruptTTS();
		clearUndo();
		clearLearningTimer();

		emit({ type: 'command', command });

		if (!currentCard) return;

		switch (command) {
			case 'answer':
				phase = 'rating';
				emit({ type: 'phase_change', phase: 'rating' });
				speakText(currentCard.back);
				break;

			case 'hint': {
				const words = currentCard.back.split(/\s+/).slice(0, 3).join(' ');
				speakText(words + '...');
				break;
			}

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
				if (phase === 'question') {
					phase = 'rating';
					emit({ type: 'phase_change', phase: 'rating' });
				}
				submitRating(command);
				break;
			}

			case 'explain':
				handleExplain();
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
		if (!currentCard) return;

		const card = currentCard;
		const durationMs = Date.now() - cardStartTime;

		stats.cardsReviewed++;
		stats.ratings[rating]++;

		// Track studied note for sibling dedup
		studiedNoteIds.add(card.note_id);

		// Submit to server and get fsrsState + dueAt back
		let addedToLearning = false;

		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), REVIEW_API_TIMEOUT_MS);

			const res = await fetch(`/api/cards/${card.id}/review`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ rating, durationMs }),
				signal: controller.signal
			});
			clearTimeout(timeout);

			if (res.ok) {
				const data = (await res.json()) as {
					reviewId: string;
					dueAt: string;
					fsrsState: number;
					leeched?: boolean;
				};

				const newState = data.fsrsState;
				const dueAt = new Date(data.dueAt).getTime();
				const now = Date.now();

				// If card is still learning/relearning and due within 30 min, add to learning queue
				// If leeched, emit suspended event and don't add to learning queue
				// In cram mode, skip learning queue insertion
				if (data.leeched) {
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
			}
		} catch {
			// Timeout or network error — continue without learning queue insertion
			emit({ type: 'error', message: 'Failed to save review' });
		}

		// Store undo info
		undoInfo = { rating, card, addedToLearning };
		emit({ type: 'undo_available', available: true });

		undoTimer = setTimeout(() => {
			undoInfo = null;
			emit({ type: 'undo_available', available: false });
		}, 5000);

		playSound('/success.mp3').catch(() => {});
		presentCard();
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

	function performUndo() {
		if (!undoInfo) return;

		interruptTTS();
		clearLearningTimer();

		const { rating, card, addedToLearning } = undoInfo;

		// Fire-and-forget server-side undo
		fetch(`/api/cards/${card.id}/review/undo`, { method: 'POST' }).catch(() => {});

		// Revert stats
		stats.cardsReviewed--;
		stats.ratings[rating]--;
		cardsReviewedCount--;

		// Remove from learning queue if it was added
		if (addedToLearning) {
			const idx = learningQueue.findIndex((e) => e.card.id === card.id);
			if (idx !== -1) learningQueue.splice(idx, 1);
		}

		clearUndo();

		// Re-present the card in rating phase
		currentCard = card;
		phase = 'rating';
		cardStartTime = Date.now();
		cardsReviewedCount++;

		const isLearning =
			card.fsrs_state === STATE_LEARNING || card.fsrs_state === STATE_RELEARNING;

		emit({
			type: 'card_change',
			index: cardsReviewedCount - 1,
			total: cardsReviewedCount,
			front: card.front,
			back: card.back,
			isLearning
		});
		emit({ type: 'phase_change', phase: 'rating' });

		if (micOn) emit({ type: 'listening' });
		else emit({ type: 'idle' });
	}

	async function handleExplain() {
		interruptTTS();
		emit({ type: 'explaining' });
		if (!currentCard) return;

		try {
			const res = await fetch('/api/explain', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ front: currentCard.front, back: currentCard.back })
			});

			if (!res.ok) throw new Error('Explain API failed');
			const { explanation } = (await res.json()) as { explanation: string };

			speakText(explanation);
			playSound('/chime.mp3').catch(() => {});
		} catch {
			emit({ type: 'error', message: 'Failed to get explanation' });
			if (micOn) emit({ type: 'listening' });
			else emit({ type: 'idle' });
		}
	}

	function endSession() {
		interruptTTS();
		clearUndo();
		clearLearningTimer();
		stats.durationMs = Date.now() - startTime;
		deepgram?.stop();
		playSound('/complete.mp3').catch(() => {});
		emit({ type: 'session_end', stats });
	}

	async function start(deckId: string, options?: StartOptions) {
		destroyed = false;
		startTime = Date.now();
		isCramMode = options?.mode === 'cram';

		// 1. Unlock audio for iOS
		await unlockAudio();

		// 2. Fetch due cards
		const params = new URLSearchParams({ deckId, limit: '50' });
		if (options?.tags) params.set('tags', options.tags);
		if (options?.mode) params.set('mode', options.mode);
		if (options?.cramState) params.set('cramState', options.cramState);
		const res = await fetch(`/api/cards/next?${params}`);
		if (!res.ok) {
			emit({ type: 'error', message: 'Failed to fetch cards' });
			return;
		}

		const data = (await res.json()) as { cards: Record<string, unknown>[]; deckName: string };
		if (data.deckName) {
			emit({ type: 'deck_info', name: data.deckName });
		}
		if (!data.cards || data.cards.length === 0) {
			emit({ type: 'session_end', stats });
			return;
		}

		// Parse card fronts/backs into review queue
		reviewQueue = data.cards.map((c) => {
			const { front, back } = renderCard(c.fields as string, c.card_type as string);
			return {
				id: c.id as string,
				note_id: c.note_id as string,
				card_type: c.card_type as string,
				fsrs_state: c.fsrs_state as number,
				model_name: c.model_name as string,
				fields: c.fields as string,
				tags: c.tags as string,
				front,
				back
			};
		});
		learningQueue = [];
		studiedNoteIds = new Set();
		currentCard = null;
		cardsReviewedCount = 0;

		// 3. Start Deepgram STT
		deepgram = createDeepgramClient();
		deepgram.onTranscript((transcript, isFinal) => {
			emit({ type: 'transcript', text: transcript, isFinal });

			if (isFinal) {
				const command = matchCommand(transcript, phase);
				if (command) {
					handleCommand(command);
				}
			}
		});
		deepgram.onError((err) => {
			emit({ type: 'error', message: err.message });
		});

		try {
			await deepgram.start();
		} catch (err) {
			emit({
				type: 'error',
				message: `Microphone error: ${err instanceof Error ? err.message : 'Unknown'}`
			});
			return;
		}

		// 4. Present first card
		presentCard();
	}

	function destroy() {
		destroyed = true;
		clearUndo();
		clearLearningTimer();
		stopPlayback();
		deepgram?.stop();
	}

	function toggleMic() {
		micOn = !micOn;
		if (micOn) {
			deepgram?.resume();
		} else {
			deepgram?.pause();
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

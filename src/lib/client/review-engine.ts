import { speak, stopPlayback, getLastSpokenText, unlockAudio, playSound } from './audio';
import { createDeepgramClient, type DeepgramClient } from './deepgram';
import { matchCommand } from '../commands';
import type { ReviewPhase, VoiceCommand, RatingName, NoteField } from '../types';

export type ReviewEvent =
	| { type: 'phase_change'; phase: ReviewPhase }
	| { type: 'card_change'; index: number; total: number; front: string; back: string }
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
	| { type: 'audio_change'; audioOn: boolean };

export interface SessionStats {
	cardsReviewed: number;
	ratings: Record<RatingName, number>;
	durationMs: number;
}

interface CardData {
	id: string;
	card_type: string;
	model_name: string;
	fields: string;
	tags: string;
	front: string;
	back: string;
}

type EventCallback = (event: ReviewEvent) => void;

export interface ReviewEngine {
	start(deckId: string): Promise<void>;
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

export function createReviewEngine(): ReviewEngine {
	let eventCb: EventCallback | null = null;
	let deepgram: DeepgramClient | null = null;
	let phase: ReviewPhase = 'question';
	let cards: CardData[] = [];
	let currentIndex = 0;
	let startTime = 0;
	let cardStartTime = 0;
	let destroyed = false;
	let audioOn = true;
	let micOn = true;
	let isSpeaking = false;
	let speakGen = 0;
	let undoInfo: { index: number; rating: RatingName; cardId: string } | null = null;
	let undoTimer: ReturnType<typeof setTimeout> | null = null;
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
	 * Returns immediately. Any command execution will interrupt via stopPlayback().
	 */
	function speakText(text: string) {
		speakGen++;
		const gen = speakGen;

		if (!audioOn) {
			// Audio muted — skip TTS, stay in listening state
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
		speakGen++; // Invalidate any in-flight speech callbacks
		stopPlayback();
		isSpeaking = false;
	}

	function presentCard() {
		if (currentIndex >= cards.length) {
			endSession();
			return;
		}

		const card = cards[currentIndex];
		phase = 'question';
		cardStartTime = Date.now();

		emit({
			type: 'card_change',
			index: currentIndex,
			total: cards.length,
			front: card.front,
			back: card.back
		});
		emit({ type: 'phase_change', phase: 'question' });

		speakText(card.front);
	}

	function handleCommand(command: VoiceCommand) {
		// Interrupt any ongoing TTS
		interruptTTS();

		// Clear undo window on new action (except undo itself)
		clearUndo();

		emit({ type: 'command', command });

		const card = cards[currentIndex];

		switch (command) {
			case 'answer':
				phase = 'rating';
				emit({ type: 'phase_change', phase: 'rating' });
				speakText(card.back);
				break;

			case 'hint': {
				const words = card.back.split(/\s+/).slice(0, 3).join(' ');
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
				// If in question phase, skip to answer display first for ratings
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

			case 'stop':
				endSession();
				break;
		}
	}

	function submitRating(rating: RatingName) {
		const card = cards[currentIndex];
		const durationMs = Date.now() - cardStartTime;

		stats.cardsReviewed++;
		stats.ratings[rating]++;

		// Store undo info
		undoInfo = { index: currentIndex, rating, cardId: card.id };
		emit({ type: 'undo_available', available: true });

		// Auto-clear undo after 5 seconds
		undoTimer = setTimeout(() => {
			undoInfo = null;
			emit({ type: 'undo_available', available: false });
		}, 5000);

		// Submit to server (fire-and-forget)
		fetch(`/api/cards/${card.id}/review`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ rating, durationMs })
		}).catch(() => {
			emit({ type: 'error', message: 'Failed to save review' });
		});

		playSound('/success.mp3').catch(() => {});
		currentIndex++;
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

		// Revert stats
		stats.cardsReviewed--;
		stats.ratings[undoInfo.rating]--;

		// Go back to that card
		currentIndex = undoInfo.index;
		clearUndo();

		// Re-present the card in rating phase (they already saw the answer)
		const card = cards[currentIndex];
		phase = 'rating';
		cardStartTime = Date.now();

		emit({
			type: 'card_change',
			index: currentIndex,
			total: cards.length,
			front: card.front,
			back: card.back
		});
		emit({ type: 'phase_change', phase: 'rating' });

		if (micOn) emit({ type: 'listening' });
		else emit({ type: 'idle' });
	}

	async function handleExplain() {
		interruptTTS();
		emit({ type: 'explaining' });
		const card = cards[currentIndex];

		try {
			const res = await fetch('/api/explain', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ front: card.front, back: card.back })
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
		stats.durationMs = Date.now() - startTime;
		deepgram?.stop();
		playSound('/complete.mp3').catch(() => {});
		emit({ type: 'session_end', stats });
	}

	async function start(deckId: string) {
		destroyed = false;
		startTime = Date.now();

		// 1. Unlock audio for iOS
		await unlockAudio();

		// 2. Fetch due cards
		const res = await fetch(`/api/cards/next?deckId=${deckId}&limit=50`);
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

		// Parse card fronts/backs
		cards = data.cards.map((c) => {
			const { front, back } = renderCard(c.fields as string, c.card_type as string);
			return { ...c, front, back } as CardData;
		});
		currentIndex = 0;

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
		start,
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

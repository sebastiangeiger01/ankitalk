export interface User {
	id: string;
	hanko_id: string;
	created_at: string;
	updated_at: string;
}

export interface Deck {
	id: string;
	user_id: string;
	anki_id: number | null;
	name: string;
	description: string;
	card_count: number;
	created_at: string;
	updated_at: string;
}

export interface DeckWithDueCount extends Deck {
	due_count: number;
}

export interface Note {
	id: string;
	user_id: string;
	deck_id: string;
	anki_id: number | null;
	model_name: string;
	fields: string; // JSON array of {name, value}
	tags: string;
	created_at: string;
}

export interface NoteField {
	name: string;
	value: string;
}

export interface Card {
	id: string;
	user_id: string;
	deck_id: string;
	note_id: string;
	anki_id: number | null;
	ordinal: number;
	card_type: 'basic' | 'cloze';
	due_at: string;
	fsrs_state: number;
	fsrs_stability: number;
	fsrs_difficulty: number;
	fsrs_elapsed_days: number;
	fsrs_scheduled_days: number;
	fsrs_reps: number;
	fsrs_lapses: number;
	fsrs_last_review: string | null;
	buried_until: string | null;
	suspended: number;
	created_at: string;
	updated_at: string;
}

export interface DeckSettings {
	deck_id: string;
	new_cards_per_day: number;
	max_reviews_per_day: number;
	desired_retention: number;
	max_interval: number;
	leech_threshold: number;
	created_at: string;
	updated_at: string;
}

export interface Review {
	id: string;
	user_id: string;
	card_id: string;
	deck_id: string;
	rating: RatingName;
	duration_ms: number | null;
	created_at: string;
}

/** Card joined with its note for review display */
export interface ReviewCard {
	card: Card;
	note: Note;
	fields: NoteField[];
}

export type ReviewPhase = 'question' | 'rating';

export type VoiceCommand =
	| 'answer'
	| 'hint'
	| 'repeat'
	| 'again'
	| 'hard'
	| 'good'
	| 'easy'
	| 'stop'
	| 'explain'
	| 'suspend';

export type RatingName = 'again' | 'hard' | 'good' | 'easy';

/** Card joined with note fields for the card browser */
export interface BrowseCard {
	id: string;
	note_id: string;
	card_type: string;
	due_at: string;
	fsrs_state: number;
	fsrs_reps: number;
	fsrs_lapses: number;
	suspended: number;
	fields: string;
	tags: string;
}

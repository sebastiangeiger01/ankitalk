export type ListenStatus = 'pending' | 'generating' | 'complete' | 'partial' | 'failed';

export interface ListenDocumentSummary {
	id: string;
	title: string;
	status: ListenStatus;
	total_chars: number;
	/** Number of TTS units (sentences) — stored on the document for fast listing. */
	segment_count: number;
	/** How many sentences currently have warm cached audio for this user. */
	done_count: number;
	tts_model: string;
	voice_id: string;
	estimated_credits: number;
	estimated_cost_usd: number;
	created_at: string;
	expires_at: string;
}

/** Reader-model: a single sentence (TTS unit) inside a document. */
export interface ListenSentenceInfo {
	seq: number;
	text: string;
	char_count: number;
	sentence_hash: string;
	/** Audio currently cached for this user — playback is free. */
	cached: boolean;
	/** Actual MP3 duration if cached, otherwise an estimate from char_count. */
	duration_ms: number;
}

export interface ListenSentencesResponse {
	document: {
		id: string;
		title: string;
		voice_id: string;
		tts_model: string;
		language: string | null;
		total_chars: number;
		sentence_count: number;
		created_at: string;
		expires_at: string;
	};
	sentences: ListenSentenceInfo[];
	cached_count: number;
}

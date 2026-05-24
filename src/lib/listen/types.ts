export type ListenStatus = 'pending' | 'generating' | 'complete' | 'partial' | 'failed';
export type SegmentStatus = 'pending' | 'generating' | 'done' | 'failed';

export interface ListenDocumentSummary {
	id: string;
	title: string;
	status: ListenStatus;
	total_chars: number;
	segment_count: number;
	done_count: number;
	tts_model: string;
	voice_id: string;
	estimated_credits: number;
	estimated_cost_usd: number;
	created_at: string;
	expires_at: string;
}

export interface ListenSegmentInfo {
	seq: number;
	status: SegmentStatus;
	char_count: number;
	source_text?: string;
}

export interface ListenGenerateResponse {
	document: { id: string; status: ListenStatus; doneCount: number; segmentCount: number };
	processed: { seq: number; status: SegmentStatus; error?: string }[];
	remaining: number;
}

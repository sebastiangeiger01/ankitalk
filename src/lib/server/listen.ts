import type { ElevenLabsTtsSettings } from './tts';
import type { UserVoiceSettings } from '$lib/voice';
import type { ListenStatus } from '$lib/listen/types';

export const LISTEN_MAX_TEXT_CHARS = 200_000;
export const LISTEN_KEY_PREFIX = 'listen';

export interface ListenDocumentRow {
	id: string;
	user_id: string;
	title: string;
	status: ListenStatus;
	total_chars: number;
	segment_count: number;
	tts_model: string;
	voice_id: string;
	estimated_credits: number;
	estimated_cost_usd: number;
	content_hash: string;
	language: string | null;
	created_at: string;
	updated_at: string;
	expires_at: string;
}

export function listenR2Key(userId: string, documentId: string, seq: number): string {
	return `${LISTEN_KEY_PREFIX}/${userId}/${documentId}/${seq}.mp3`;
}

export function resolveListenTitle(provided: string | undefined, text: string): string {
	const explicit = provided?.trim();
	if (explicit) return explicit.slice(0, 120);
	const firstLine = text
		.split('\n')
		.map((line) => line.trim())
		.find(Boolean);
	return (firstLine ? firstLine.slice(0, 80) : '') || 'Untitled';
}

/** Build the ElevenLabs synthesis settings for a document, overriding voice/model on the saved tuning. */
export function buildListenTtsSettings(
	saved: UserVoiceSettings,
	voiceId: string,
	modelId: string
): ElevenLabsTtsSettings {
	return {
		elevenlabs_voice_id: voiceId,
		elevenlabs_tts_model: modelId,
		elevenlabs_tts_speed: saved.elevenlabs_tts_speed,
		elevenlabs_stability: saved.elevenlabs_stability,
		elevenlabs_similarity: saved.elevenlabs_similarity,
		elevenlabs_style: saved.elevenlabs_style,
		elevenlabs_speaker_boost: saved.elevenlabs_speaker_boost
	};
}

/**
 * Delete a user's expired documents and their R2 audio. R2 lifecycle is the source of truth for
 * bytes; this keeps D1 tidy. Safe to run opportunistically (e.g. via waitUntil) on list/detail.
 */
export async function cleanupExpiredListenDocuments(
	db: D1Database,
	media: R2Bucket,
	userId: string
): Promise<void> {
	const expired = await db
		.prepare("SELECT id FROM listen_documents WHERE user_id = ? AND expires_at <= datetime('now')")
		.bind(userId)
		.all<{ id: string }>();

	for (const { id } of expired.results) {
		const segs = await db
			.prepare('SELECT r2_key FROM listen_segments WHERE document_id = ? AND r2_key IS NOT NULL')
			.bind(id)
			.all<{ r2_key: string }>();
		await Promise.allSettled(segs.results.map((s) => media.delete(s.r2_key)));
		await db.prepare('DELETE FROM listen_documents WHERE id = ?').bind(id).run();
	}
}

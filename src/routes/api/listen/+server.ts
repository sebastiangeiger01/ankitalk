import { error, json } from '@sveltejs/kit';
import { getDb, newId } from '$lib/server/db';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import { calculateElevenLabsTtsCost } from '$lib/server/usage';
import {
	LISTEN_MAX_TEXT_CHARS,
	cleanupExpiredListenDocuments,
	resolveListenTitle
} from '$lib/server/listen';
import { chunkText } from '$lib/listen/chunk';
import { estimateCredits, hashContent } from '$lib/listen/estimate';
import { isElevenLabsTtsModel } from '$lib/voice';
import type { ListenDocumentSummary } from '$lib/listen/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	platform?.context?.waitUntil(cleanupExpiredListenDocuments(db, platform!.env.MEDIA, locals.userId));

	const rows = await db
		.prepare(
			`SELECT d.id, d.title, d.status, d.total_chars, d.segment_count, d.tts_model, d.voice_id,
				d.estimated_credits, d.estimated_cost_usd, d.created_at, d.expires_at,
				(SELECT COUNT(*) FROM listen_segments s WHERE s.document_id = d.id AND s.status = 'done') AS done_count
			 FROM listen_documents d
			 WHERE d.user_id = ? AND d.expires_at > datetime('now')
			 ORDER BY d.created_at DESC`
		)
		.bind(locals.userId)
		.all<ListenDocumentSummary>();

	return json({ documents: rows.results });
};

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	const db = getDb(platform!);
	const body = (await request.json()) as {
		text?: unknown;
		title?: unknown;
		voiceId?: unknown;
		modelId?: unknown;
		force?: unknown;
	};

	const text = typeof body.text === 'string' ? body.text : '';
	if (!text.trim()) throw error(400, 'Missing text');
	if (text.length > LISTEN_MAX_TEXT_CHARS) throw error(413, 'Text too long');

	const saved = await getUserVoiceSettings(db, userId);
	const voiceId =
		typeof body.voiceId === 'string' && body.voiceId.trim() ? body.voiceId.trim() : saved.elevenlabs_voice_id;
	const modelId = isElevenLabsTtsModel(body.modelId) ? body.modelId : saved.elevenlabs_tts_model;

	const chunks = chunkText(text);
	if (!chunks.length) throw error(400, 'No usable text');

	const totalChars = chunks.reduce((sum, c) => sum + c.length, 0);
	const estimatedCredits = estimateCredits(totalChars, modelId);
	const estimatedCostUsd = calculateElevenLabsTtsCost(totalChars, modelId);
	const contentHash = await hashContent(text, voiceId, modelId);

	if (body.force !== true) {
		const dup = await db
			.prepare(
				"SELECT id FROM listen_documents WHERE user_id = ? AND content_hash = ? AND expires_at > datetime('now') LIMIT 1"
			)
			.bind(userId, contentHash)
			.first<{ id: string }>();
		if (dup) return json({ duplicate: true, existingDocumentId: dup.id });
	}

	const docId = newId();
	const title = resolveListenTitle(typeof body.title === 'string' ? body.title : undefined, text);

	const statements = [
		db
			.prepare(
				`INSERT INTO listen_documents
					(id, user_id, title, status, total_chars, segment_count, tts_model, voice_id, estimated_credits, estimated_cost_usd, content_hash)
				 VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(docId, userId, title, totalChars, chunks.length, modelId, voiceId, estimatedCredits, estimatedCostUsd, contentHash),
		...chunks.map((chunk, i) =>
			db
				.prepare(
					`INSERT INTO listen_segments (id, document_id, user_id, seq, source_text, char_count, status)
					 VALUES (?, ?, ?, ?, ?, ?, 'pending')`
				)
				.bind(newId(), docId, userId, i, chunk, chunk.length)
		)
	];
	await db.batch(statements);

	return json({
		id: docId,
		title,
		status: 'pending',
		segmentCount: chunks.length,
		totalChars,
		estimatedCredits,
		estimatedCostUsd
	});
};

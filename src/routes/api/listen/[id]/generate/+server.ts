import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserApiKey } from '$lib/server/user-keys';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import { synthesizeElevenLabsSpeech } from '$lib/server/tts';
import { calculateElevenLabsTtsCost, logUsage } from '$lib/server/usage';
import { buildListenTtsSettings, listenR2Key, type ListenDocumentRow } from '$lib/server/listen';
import type { ListenStatus, SegmentStatus } from '$lib/listen/types';
import type { RequestHandler } from './$types';

interface SegmentRow {
	id: string;
	seq: number;
	source_text: string;
	char_count: number;
}

export const POST: RequestHandler = async ({ params, request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	const db = getDb(platform!);

	const doc = await db
		.prepare("SELECT * FROM listen_documents WHERE id = ? AND user_id = ? AND expires_at > datetime('now')")
		.bind(params.id, userId)
		.first<ListenDocumentRow>();
	if (!doc) throw error(404, 'Not found');

	const apiKey = await getUserApiKey(db, userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) {
		return json({ error: 'Add your ElevenLabs API key in Settings to generate audio' }, { status: 400 });
	}

	const body = (await request.json().catch(() => ({}))) as { batch?: unknown };
	const batch = Math.min(2, Math.max(1, typeof body.batch === 'number' ? Math.floor(body.batch) : 1));

	const saved = await getUserVoiceSettings(db, userId);
	const settings = buildListenTtsSettings(saved, doc.voice_id, doc.tts_model);

	const pending = await db
		.prepare(
			`SELECT id, seq, source_text, char_count FROM listen_segments
			 WHERE document_id = ? AND status IN ('pending', 'failed', 'generating')
			 ORDER BY seq LIMIT ?`
		)
		.bind(params.id, batch)
		.all<SegmentRow>();

	const processed: { seq: number; status: SegmentStatus; error?: string }[] = [];
	const usageWork: Promise<unknown>[] = [];

	for (const seg of pending.results) {
		await db
			.prepare("UPDATE listen_segments SET status = 'generating', updated_at = datetime('now') WHERE id = ?")
			.bind(seg.id)
			.run();

		try {
			const response = await synthesizeElevenLabsSpeech(apiKey, seg.source_text, settings);
			const buffer = await response.arrayBuffer();
			const key = listenR2Key(userId, params.id, seg.seq);
			await platform!.env.MEDIA.put(key, buffer, { httpMetadata: { contentType: 'audio/mpeg' } });

			await db
				.prepare("UPDATE listen_segments SET status = 'done', r2_key = ?, error = NULL, updated_at = datetime('now') WHERE id = ?")
				.bind(key, seg.id)
				.run();

			usageWork.push(
				logUsage(db, userId, 'elevenlabs', 'tts', seg.char_count, calculateElevenLabsTtsCost(seg.char_count, doc.tts_model))
			);
			processed.push({ seq: seg.seq, status: 'done' });
		} catch (err) {
			const message = err instanceof Error ? err.message.slice(0, 300) : 'TTS failed';
			await db
				.prepare("UPDATE listen_segments SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?")
				.bind(message, seg.id)
				.run();
			processed.push({ seq: seg.seq, status: 'failed', error: message });
			break;
		}
	}

	const counts = await db
		.prepare('SELECT status, COUNT(*) AS n FROM listen_segments WHERE document_id = ? GROUP BY status')
		.bind(params.id)
		.all<{ status: SegmentStatus; n: number }>();

	let done = 0;
	let failed = 0;
	let remaining = 0;
	for (const row of counts.results) {
		if (row.status === 'done') done = row.n;
		else if (row.status === 'failed') failed = row.n;
		else remaining += row.n; // pending + generating
	}

	let status: ListenStatus;
	if (done === doc.segment_count) status = 'complete';
	else if (remaining === 0 && failed > 0) status = done > 0 ? 'partial' : 'failed';
	else status = done > 0 ? 'generating' : 'pending';

	await db
		.prepare("UPDATE listen_documents SET status = ?, updated_at = datetime('now') WHERE id = ?")
		.bind(status, params.id)
		.run();

	if (usageWork.length) platform?.context?.waitUntil(Promise.all(usageWork));

	return json({
		document: { id: params.id, status, doneCount: done, segmentCount: doc.segment_count },
		processed,
		remaining
	});
};

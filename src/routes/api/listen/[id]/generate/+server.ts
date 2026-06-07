import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserApiKey } from '$lib/server/user-keys';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import { synthesizeElevenLabsSpeech, type ElevenLabsTtsSettings } from '$lib/server/tts';
import { calculateElevenLabsTtsCost, logUsage } from '$lib/server/usage';
import { buildListenTtsSettings, listenR2Key, type ListenDocumentRow } from '$lib/server/listen';
import type { ListenStatus, SegmentStatus } from '$lib/listen/types';
import type { RequestHandler } from './$types';

interface SegmentRow {
	id: string;
	seq: number;
	source_text: string;
	char_count: number;
	status: SegmentStatus;
	r2_key: string | null;
}

const MAX_SYNTH_RETRIES = 2;

async function synthesizeWithRetry(
	apiKey: string,
	text: string,
	settings: ElevenLabsTtsSettings,
	languageCode: string | undefined
): Promise<Response> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= MAX_SYNTH_RETRIES; attempt++) {
		try {
			return await synthesizeElevenLabsSpeech(apiKey, text, settings, languageCode);
		} catch (err) {
			lastErr = err;
			if (attempt < MAX_SYNTH_RETRIES) {
				await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
			}
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error('TTS failed');
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

	const body = (await request.json().catch(() => ({}))) as { seq?: unknown };
	if (typeof body.seq !== 'number' || !Number.isInteger(body.seq) || body.seq < 0) {
		throw error(400, 'Missing or invalid seq');
	}
	const seq = body.seq;

	const seg = await db
		.prepare(
			`SELECT id, seq, source_text, char_count, status, r2_key
			 FROM listen_segments WHERE document_id = ? AND seq = ?`
		)
		.bind(params.id, seq)
		.first<SegmentRow>();
	if (!seg) throw error(404, 'Segment not found');

	let processed: { seq: number; status: SegmentStatus; error?: string };

	if (seg.status === 'done' && seg.r2_key) {
		// Idempotent: already generated, skip.
		processed = { seq, status: 'done' };
	} else {
		const saved = await getUserVoiceSettings(db, userId);
		const settings = buildListenTtsSettings(saved, doc.voice_id, doc.tts_model);

		await db
			.prepare("UPDATE listen_segments SET status = 'generating', error = NULL, updated_at = datetime('now') WHERE id = ?")
			.bind(seg.id)
			.run();

		try {
			const response = await synthesizeWithRetry(apiKey, seg.source_text, settings, doc.language ?? undefined);
			const buffer = await response.arrayBuffer();
			const key = listenR2Key(userId, params.id, seg.seq);
			await platform!.env.MEDIA.put(key, buffer, { httpMetadata: { contentType: 'audio/mpeg' } });

			await db
				.prepare("UPDATE listen_segments SET status = 'done', r2_key = ?, error = NULL, updated_at = datetime('now') WHERE id = ?")
				.bind(key, seg.id)
				.run();

			platform?.context?.waitUntil(
				logUsage(
					db,
					userId,
					'elevenlabs',
					'tts',
					seg.char_count,
					calculateElevenLabsTtsCost(seg.char_count, doc.tts_model)
				)
			);
			processed = { seq, status: 'done' };
		} catch (err) {
			const message = err instanceof Error ? err.message.slice(0, 300) : 'TTS failed';
			await db
				.prepare("UPDATE listen_segments SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?")
				.bind(message, seg.id)
				.run();
			processed = { seq, status: 'failed', error: message };
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
		else remaining += row.n;
	}

	let status: ListenStatus;
	if (done === doc.segment_count) status = 'complete';
	else if (remaining === 0 && failed > 0) status = done > 0 ? 'partial' : 'failed';
	else status = done > 0 ? 'generating' : 'pending';

	await db
		.prepare("UPDATE listen_documents SET status = ?, updated_at = datetime('now') WHERE id = ?")
		.bind(status, params.id)
		.run();

	return json({
		document: { id: params.id, status, doneCount: done, segmentCount: doc.segment_count },
		processed: [processed],
		remaining
	});
};

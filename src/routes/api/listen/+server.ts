import { error, json } from '@sveltejs/kit';
import { getDb, newId } from '$lib/server/db';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import { calculateElevenLabsTtsCost } from '$lib/server/usage';
import {
	LISTEN_MAX_TEXT_CHARS,
	cleanupExpiredListenDocuments,
	resolveListenTitle
} from '$lib/server/listen';
import { assertSentenceCoverage, hashSentence, splitIntoSentences } from '$lib/listen/sentences';
import { estimateCredits, hashContent } from '$lib/listen/estimate';
import { isListenLanguage } from '$lib/listen/languages';
import { isElevenLabsTtsModel } from '$lib/voice';
import type { ListenDocumentSummary } from '$lib/listen/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	platform?.context?.waitUntil(cleanupExpiredListenDocuments(db, platform!.env.MEDIA, locals.userId));

	// Only reader-model (v2) documents show up in the history — legacy rows without
	// original_text are hidden so users see one consistent experience.
	const rows = await db
		.prepare(
			`SELECT d.id, d.title, d.status, d.total_chars, d.segment_count, d.tts_model, d.voice_id,
				d.estimated_credits, d.estimated_cost_usd, d.created_at, d.expires_at,
				(SELECT COUNT(*) FROM listen_sentence_cache c
				 JOIN listen_sentences s ON s.sentence_hash = c.sentence_hash
				 WHERE c.user_id = d.user_id
				   AND s.doc_id = d.id
				   AND c.expires_at > datetime('now')) AS done_count
			 FROM listen_documents d
			 WHERE d.user_id = ?
			   AND d.expires_at > datetime('now')
			   AND d.original_text IS NOT NULL
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
		language?: unknown;
		force?: unknown;
	};

	const text = typeof body.text === 'string' ? body.text : '';
	if (!text.trim()) throw error(400, 'Missing text');
	if (text.length > LISTEN_MAX_TEXT_CHARS) throw error(413, 'Text too long');

	const saved = await getUserVoiceSettings(db, userId);
	const voiceId =
		typeof body.voiceId === 'string' && body.voiceId.trim() ? body.voiceId.trim() : saved.elevenlabs_voice_id;
	const modelId = isElevenLabsTtsModel(body.modelId) ? body.modelId : saved.elevenlabs_tts_model;
	const language = isListenLanguage(body.language) ? body.language : null;
	const languageForHash = language ?? '';

	const sentences = splitIntoSentences(text);
	if (!sentences.length) throw error(400, 'No usable text');
	try {
		assertSentenceCoverage(text, sentences);
	} catch (err) {
		throw error(500, `Text splitting failed: ${err instanceof Error ? err.message : 'unknown'}`);
	}

	const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
	const estimatedCredits = estimateCredits(totalChars, modelId);
	const estimatedCostUsd = calculateElevenLabsTtsCost(totalChars, modelId);
	const contentHash = await hashContent(text, voiceId, modelId, language ?? 'auto');

	if (body.force !== true) {
		const dup = await db
			.prepare(
				"SELECT id FROM listen_documents WHERE user_id = ? AND content_hash = ? AND expires_at > datetime('now') AND original_text IS NOT NULL LIMIT 1"
			)
			.bind(userId, contentHash)
			.first<{ id: string }>();
		if (dup) return json({ duplicate: true, existingDocumentId: dup.id });
	}

	// Pre-hash every sentence so the insert batch is a single atomic round trip.
	const sentenceHashes = await Promise.all(
		sentences.map((s) => hashSentence(s, voiceId, modelId, languageForHash))
	);

	const docId = newId();
	const title = resolveListenTitle(typeof body.title === 'string' ? body.title : undefined, text);

	const statements = [
		db
			.prepare(
				`INSERT INTO listen_documents
					(id, user_id, title, status, total_chars, segment_count, tts_model, voice_id,
					 estimated_credits, estimated_cost_usd, content_hash, language, original_text)
				 VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				docId,
				userId,
				title,
				totalChars,
				sentences.length,
				modelId,
				voiceId,
				estimatedCredits,
				estimatedCostUsd,
				contentHash,
				language,
				text
			),
		...sentences.map((s, i) =>
			db
				.prepare(
					'INSERT INTO listen_sentences (doc_id, seq, text, char_count, sentence_hash) VALUES (?, ?, ?, ?, ?)'
				)
				.bind(docId, i, s, s.length, sentenceHashes[i])
		)
	];
	await db.batch(statements);

	return json({
		id: docId,
		title,
		status: 'pending',
		sentenceCount: sentences.length,
		totalChars,
		estimatedCredits,
		estimatedCostUsd
	});
};

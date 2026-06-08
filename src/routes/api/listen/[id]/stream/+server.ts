import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserApiKey } from '$lib/server/user-keys';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import { buildListenTtsSettings, type ListenDocumentRow } from '$lib/server/listen';
import { getOrSynthesizeSentence } from '$lib/server/listen-tts';
import type { RequestHandler } from './$types';

interface SentenceRow {
	seq: number;
	text: string;
	char_count: number;
	sentence_hash: string;
}

/**
 * The single endpoint that drives playback. The browser sees a normal `<audio>` source —
 * a chunked HTTP MP3 stream — so background playback, lockscreen controls and AirPlay all
 * work through the native AVPlayer / MediaSession pipeline with no client-side stitching.
 *
 * For each sentence from `?from=N` onwards we either pipe cached R2 bytes or call ElevenLabs
 * once (storing the result for next time). The connection stays open until the client
 * disconnects or all sentences finish.
 */
export const GET: RequestHandler = async ({ params, url, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	const from = Math.max(0, Number(url.searchParams.get('from') ?? 0));
	if (!Number.isFinite(from)) throw error(400, 'Invalid from');

	const db = getDb(platform!);
	const doc = await db
		.prepare(
			"SELECT * FROM listen_documents WHERE id = ? AND user_id = ? AND expires_at > datetime('now')"
		)
		.bind(params.id, userId)
		.first<ListenDocumentRow>();
	if (!doc) throw error(404, 'Not found');
	if (doc.original_text === null) throw error(409, 'Legacy document — please regenerate');

	const apiKey = await getUserApiKey(db, userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) throw error(400, 'Add your ElevenLabs API key in Settings');

	const sentencesRes = await db
		.prepare(
			'SELECT seq, text, char_count, sentence_hash FROM listen_sentences WHERE doc_id = ? AND seq >= ? ORDER BY seq'
		)
		.bind(params.id, from)
		.all<SentenceRow>();

	const sentences = sentencesRes.results;
	if (!sentences.length) throw error(404, 'No sentences');

	const saved = await getUserVoiceSettings(db, userId);
	const settings = buildListenTtsSettings(saved, doc.voice_id, doc.tts_model);
	const language = doc.language ?? undefined;
	const media = platform!.env.MEDIA;
	const kv = platform!.env.KV;

	const ctx = platform!.context;
	const waitUntil = (p: Promise<unknown>) => ctx.waitUntil(p.catch(() => undefined));

	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();

	// Kick off generation; do NOT await — the Response returns immediately so the browser
	// can start consuming. waitUntil keeps the loop alive even if the client disconnects
	// mid-stream, so the *current* sentence finishes its R2 cache write (the user paid for it).
	//
	// Throttle: cap how far ahead we run-ahead of audible playback by sleeping
	// `durationMs / 2` between sentence writes. That keeps generation at ~2× real-time,
	// which is enough to stay ahead of the browser buffer but stops us from pre-generating
	// 5 minutes of audio that the user may never hear after pausing.
	ctx.waitUntil(
		(async () => {
			let writtenMs = 0;
			const realStart = Date.now();
			try {
				for (const sentence of sentences) {
					const result = await getOrSynthesizeSentence(
						db,
						media,
						kv,
						userId,
						apiKey,
						sentence.text,
						sentence.char_count,
						sentence.sentence_hash,
						settings,
						language,
						waitUntil
					);
					await writer.write(result.bytes);
					writtenMs += result.durationMs;
					const elapsed = Date.now() - realStart;
					const targetElapsed = writtenMs / 2; // 2× real-time
					if (elapsed < targetElapsed) {
						await new Promise((r) => setTimeout(r, targetElapsed - elapsed));
					}
				}
				await writer.close();
			} catch (err) {
				try {
					await writer.abort(err instanceof Error ? err : new Error('stream failed'));
				} catch {
					/* best-effort */
				}
			}
		})()
	);

	return new Response(readable, {
		headers: {
			'Content-Type': 'audio/mpeg',
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'Cross-Origin-Resource-Policy': 'same-origin',
			// Hint to clients that we may run a long time and can't seek by byte.
			'Accept-Ranges': 'none'
		}
	});
};

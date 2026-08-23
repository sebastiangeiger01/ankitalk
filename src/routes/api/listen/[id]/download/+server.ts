import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserApiKey } from '$lib/server/user-keys';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import { buildListenTtsSettings, type ListenDocumentRow } from '$lib/server/listen';
import { getOrSynthesizeSentence } from '$lib/server/listen-tts';
import { hashSentence } from '$lib/listen/sentences';
import { contentDisposition, downloadFilename, stripId3v2 } from '$lib/listen/mp3';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/rate-limit';
import type { RequestHandler } from './$types';

/** ElevenLabs' supported speed range, mirroring the stream endpoint's cache lanes. */
const MIN_GEN_SPEED = 0.7;
const MAX_GEN_SPEED = 1.2;

function clampSpeed(raw: string | null): number {
	const n = raw === null ? 1 : Number(raw);
	if (!Number.isFinite(n)) return 1;
	return Math.max(MIN_GEN_SPEED, Math.min(MAX_GEN_SPEED, n));
}

interface SentenceRow {
	seq: number;
	text: string;
	char_count: number;
	sentence_hash: string;
}

/**
 * Download the whole document as one MP3 file.
 *
 * Same sentence-by-sentence pipeline as `/stream`, with three deliberate differences:
 *
 *  - It always starts at sentence 0 and runs to the end — this is a file, not a position.
 *  - No run-ahead pacing. The stream throttles so that pausing doesn't leave minutes of
 *    pre-billed audio behind; a download has no pause and no playhead to stay ahead of, so
 *    pacing would only make the user wait.
 *  - Each segment's leading ID3v2 tag is stripped, so the concatenation is a clean run of
 *    frames for players stricter than a browser (see `$lib/listen/mp3`).
 *
 * Anything not yet cached is synthesized and billed exactly as playing it would be — the cost
 * is shown in the UI before the download starts. Everything generated here lands in the
 * sentence cache, so a download also warms the document for later listening, and a download
 * that dies partway through (a very long document can run into the platform's per-invocation
 * subrequest budget) costs nothing to retry: the second attempt reads back what the first one
 * already paid for and only pays for the remainder.
 */
interface DownloadContext {
	doc: ListenDocumentRow;
	apiKey: string;
	sentences: SentenceRow[];
}

/**
 * Everything that can fail before a single byte is produced: ownership, expiry, the API key,
 * and whether the document has any sentences at all. Shared with `HEAD` so the client can ask
 * "would this download work?" and show a proper message, instead of finding out by saving an
 * error page under an .mp3 name.
 */
async function resolveDownload(
	platform: App.Platform,
	userId: string,
	docId: string
): Promise<DownloadContext> {
	const db = getDb(platform);
	const doc = await db
		.prepare(
			"SELECT * FROM listen_documents WHERE id = ? AND user_id = ? AND expires_at > datetime('now')"
		)
		.bind(docId, userId)
		.first<ListenDocumentRow>();
	if (!doc) throw error(404, 'Not found');
	if (doc.original_text === null) throw error(409, 'Legacy document — please regenerate');

	const apiKey = await getUserApiKey(db, userId, 'elevenlabs', platform.env.ENCRYPTION_KEY);
	if (!apiKey) throw error(400, 'Add your ElevenLabs API key in Settings');

	const sentencesRes = await db
		.prepare(
			'SELECT seq, text, char_count, sentence_hash FROM listen_sentences WHERE doc_id = ? ORDER BY seq'
		)
		// Ownership is already established by the document lookup above.
		.bind(docId)
		.all<SentenceRow>();
	const sentences = sentencesRes.results;
	if (!sentences.length) throw error(404, 'No sentences');

	return { doc, apiKey, sentences };
}

/**
 * Preflight for the download button: same checks, no body and no generation. Deliberately not
 * rate-limited — it costs a few reads, and burning the download bucket on a check the user
 * did not ask for would lock them out of the thing they did ask for.
 */
export const HEAD: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');
	const { doc } = await resolveDownload(platform!, locals.userId, params.id);
	return new Response(null, {
		headers: {
			'Content-Type': 'audio/mpeg',
			'Content-Disposition': contentDisposition(downloadFilename(doc.title)),
			'Cache-Control': 'no-store'
		}
	});
};

export const GET: RequestHandler = async ({ params, url, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	await enforceRateLimit(
		platform!.env.KV,
		userId,
		'listen_download',
		RATE_LIMITS.listen_download_per_hour.limit,
		RATE_LIMITS.listen_download_per_hour.windowSec
	);

	const genSpeed = clampSpeed(url.searchParams.get('speed'));
	const db = getDb(platform!);
	const { doc, apiKey, sentences } = await resolveDownload(platform!, userId, params.id);

	const saved = await getUserVoiceSettings(db, userId);
	const settings = {
		...buildListenTtsSettings(saved, doc.voice_id, doc.tts_model),
		elevenlabs_tts_speed: genSpeed
	};
	const language = doc.language ?? undefined;
	const media = platform!.env.MEDIA;
	const kv = platform!.env.KV;

	const ctx = platform!.context;
	const waitUntil = (p: Promise<unknown>) => ctx.waitUntil(p.catch(() => undefined));

	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();

	// Not awaited: the response returns immediately so the browser can start writing to disk
	// while the rest is still being assembled.
	ctx.waitUntil(
		(async () => {
			try {
				for (const sentence of sentences) {
					const cacheHash =
						genSpeed === 1
							? sentence.sentence_hash
							: await hashSentence(
									sentence.text,
									doc.voice_id,
									doc.tts_model,
									language ?? '',
									genSpeed
								);
					const result = await getOrSynthesizeSentence(
						db,
						media,
						kv,
						userId,
						apiKey,
						sentence.text,
						sentence.char_count,
						cacheHash,
						settings,
						language,
						waitUntil
					);
					await writer.write(stripId3v2(result.bytes));
				}
				await writer.close();
			} catch (err) {
				// Aborting marks the response body as failed, so the browser discards the partial
				// file instead of leaving the user with a silently truncated download.
				try {
					await writer.abort(err instanceof Error ? err : new Error('download failed'));
				} catch {
					/* best-effort */
				}
			}
		})()
	);

	return new Response(readable, {
		headers: {
			'Content-Type': 'audio/mpeg',
			// No Content-Length: the total is only knowable after every sentence exists, and
			// guessing it would truncate the file. The browser shows an indeterminate progress.
			'Content-Disposition': contentDisposition(downloadFilename(doc.title)),
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'Cross-Origin-Resource-Policy': 'same-origin',
			'Accept-Ranges': 'none'
		}
	});
};

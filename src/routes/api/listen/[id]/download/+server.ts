import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { type ListenDocumentRow } from '$lib/server/listen';
import { loadDocumentCacheState, type CachedSentence } from '$lib/server/listen-cache-state';
import { contentDisposition, downloadFilename, stripId3v2 } from '$lib/listen/mp3';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/rate-limit';
import type { RequestHandler } from './$types';

/** ElevenLabs' supported speed range, mirroring the stream endpoint's cache lanes. */
const MIN_GEN_SPEED = 0.7;
const MAX_GEN_SPEED = 1.2;

/** Days a downloaded document's audio stays warm, matching the listen cache's own window. */
const CACHE_EXTEND_DAYS = 14;

function clampSpeed(raw: string | null): number {
	const n = raw === null ? 1 : Number(raw);
	if (!Number.isFinite(n)) return 1;
	return Math.max(MIN_GEN_SPEED, Math.min(MAX_GEN_SPEED, n));
}

interface ResolvedDownload {
	doc: ListenDocumentRow;
	sentences: CachedSentence[];
	pendingCount: number;
	total: number;
}

/**
 * Ownership, expiry, and — the important one — whether every sentence already has audio.
 *
 * This endpoint deliberately synthesizes nothing. It used to, and that was the bug: a document
 * with more than roughly fifty missing sentences produced a file that just stopped partway
 * through, because the generation loop ran unbounded inside a single invocation. Generating is
 * now the client's job, one bounded batch at a time via `/generate`, and this route's only
 * responsibility is to concatenate audio that already exists. That makes it fast, cheap, and
 * unable to hand back a half-finished file.
 */
async function resolveDownload(
	platform: App.Platform,
	userId: string,
	docId: string,
	genSpeed: number
): Promise<ResolvedDownload> {
	const db = getDb(platform);
	const doc = await db
		.prepare(
			"SELECT * FROM listen_documents WHERE id = ? AND user_id = ? AND expires_at > datetime('now')"
		)
		.bind(docId, userId)
		.first<ListenDocumentRow>();
	if (!doc) throw error(404, 'Not found');
	if (doc.original_text === null) throw error(409, 'Legacy document — please regenerate');

	const state = await loadDocumentCacheState(db, userId, doc, genSpeed);
	if (!state.sentences.length) throw error(404, 'No sentences');

	return {
		doc,
		sentences: state.sentences,
		pendingCount: state.pending.length,
		total: state.sentences.length
	};
}

/**
 * Preflight for the download button: the same checks, no body. Tells the client whether the
 * document is complete (`X-Listen-Pending: 0`) so it can run the generate phase first and show
 * a proper progress display, instead of discovering the gap by saving a short file.
 *
 * Not rate-limited: it costs two reads, and burning the download bucket on a check the user
 * did not ask for would lock them out of the thing they did.
 */
export const HEAD: RequestHandler = async ({ params, url, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');
	const genSpeed = clampSpeed(url.searchParams.get('speed'));
	const { doc, pendingCount, total } = await resolveDownload(
		platform!,
		locals.userId,
		params.id,
		genSpeed
	);
	return new Response(null, {
		headers: {
			'Content-Type': 'audio/mpeg',
			'Content-Disposition': contentDisposition(downloadFilename(doc.title)),
			'Cache-Control': 'no-store',
			'X-Listen-Pending': String(pendingCount),
			'X-Listen-Total': String(total)
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
	const { doc, sentences, pendingCount, total } = await resolveDownload(
		platform!,
		userId,
		params.id,
		genSpeed
	);

	if (pendingCount > 0) {
		// A JSON refusal, not a partial file. The client generates the remainder and retries;
		// anyone hitting the URL directly gets told exactly what is missing.
		return json(
			{
				error: 'Document is not fully generated yet',
				pending: pendingCount,
				total
			},
			{ status: 409, headers: { 'Cache-Control': 'no-store' } }
		);
	}

	const db = getDb(platform!);
	const media = platform!.env.MEDIA;
	const ctx = platform!.context;

	// One sentence per pull, driven by the client's reads rather than by a task detached from
	// the response. That is the same lesson as the generation bug: work pushed into
	// `ctx.waitUntil` runs on borrowed time, and a long document's worth of R2 reads is not
	// something to borrow. A pull source also gets backpressure for free — nothing is read from
	// R2 until the browser is ready for it — so memory stays flat however long the document is.
	let index = 0;
	const readable = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (index >= sentences.length) {
				controller.close();
				return;
			}
			const sentence = sentences[index++];
			const obj = await media.get(sentence.r2Key!);
			if (!obj) {
				// The cache row promised this object. If it is gone, the file would be silently
				// short, so fail the response and let the browser discard the partial download.
				controller.error(new Error(`Missing audio for sentence ${sentence.seq}`));
				return;
			}
			controller.enqueue(stripId3v2(new Uint8Array(await obj.arrayBuffer())));
		}
	});

	// Downloading a document is a strong signal of interest, so keep its audio warm — one
	// statement for the whole document rather than a write per sentence. Only meaningful on
	// the canonical speed lane, where `listen_sentences.sentence_hash` is the cache key.
	if (genSpeed === 1) {
		ctx.waitUntil(
			db
				.prepare(
					`UPDATE listen_sentence_cache
					 SET expires_at = datetime('now', '+${CACHE_EXTEND_DAYS} days')
					 WHERE user_id = ?
					   AND sentence_hash IN (SELECT sentence_hash FROM listen_sentences WHERE doc_id = ?)`
				)
				.bind(userId, doc.id)
				.run()
				.catch(() => undefined)
		);
	}

	return new Response(readable, {
		headers: {
			'Content-Type': 'audio/mpeg',
			// No Content-Length: stripping a leading ID3 tag changes each segment's size, so any
			// total computed from the stored byte sizes could truncate the file.
			'Content-Disposition': contentDisposition(downloadFilename(doc.title)),
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'Cross-Origin-Resource-Policy': 'same-origin',
			'Accept-Ranges': 'none'
		}
	});
};

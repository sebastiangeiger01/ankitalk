import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserApiKey } from '$lib/server/user-keys';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import { buildListenTtsSettings, type ListenDocumentRow } from '$lib/server/listen';
import { getOrSynthesizeSentence } from '$lib/server/listen-tts';
import { loadDocumentCacheState } from '$lib/server/listen-cache-state';
import { clampGenerateBatch, MAX_GENERATE_BATCH } from '$lib/listen/generate';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/rate-limit';
import type { RequestHandler } from './$types';

const MIN_GEN_SPEED = 0.7;
const MAX_GEN_SPEED = 1.2;

function clampSpeed(raw: string | null): number {
	const n = raw === null ? 1 : Number(raw);
	if (!Number.isFinite(n)) return 1;
	return Math.max(MIN_GEN_SPEED, Math.min(MAX_GEN_SPEED, n));
}

/**
 * Synthesize the next batch of a document's missing sentences, and report what is left.
 *
 * This exists because a whole document cannot be generated in one request. The download used to
 * try, running its generation loop inside `ctx.waitUntil` — detached from the response — and it
 * stopped after roughly fifty new sentences. The exact ceiling is unproven: the runtime's grace
 * period for detached work and the provider's rate limit under a burst with no pacing both fit
 * the observed number. They also share a fix, which is to stop doing unbounded work in one
 * invocation. (Playback hits the same wall but survives it, because a dropped stream reconnects
 * and the next invocation resumes where the last stopped. The download had no such recovery.)
 *
 * So the client drives instead: it calls this until `remaining` reaches zero, then downloads a
 * document it knows is complete. Each call is a normal awaited request — bounded work, its own
 * invocation, its own budget — and every sentence it finishes is cached, so an interrupted run
 * costs nothing to resume and warms the document for ordinary listening too.
 */
export const POST: RequestHandler = async ({ params, url, request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	await enforceRateLimit(
		platform!.env.KV,
		userId,
		'listen_generate',
		RATE_LIMITS.listen_generate_per_minute.limit,
		RATE_LIMITS.listen_generate_per_minute.windowSec
	);

	const body = (await request.json().catch(() => ({}))) as { limit?: unknown };
	const batchSize = clampGenerateBatch(body.limit);
	const genSpeed = clampSpeed(url.searchParams.get('speed'));

	const db = getDb(platform!);
	const doc = await db
		.prepare(
			"SELECT * FROM listen_documents WHERE id = ? AND user_id = ? AND expires_at > datetime('now')"
		)
		.bind(params.id, userId)
		.first<ListenDocumentRow>();
	if (!doc) throw error(404, 'Not found');
	if (doc.original_text === null) throw error(409, 'Legacy document — please regenerate');

	const state = await loadDocumentCacheState(db, userId, doc, genSpeed);
	if (!state.sentences.length) throw error(404, 'No sentences');

	const total = state.sentences.length;
	if (!state.pending.length) {
		return json({ generated: 0, remaining: 0, total, cached: total });
	}

	const apiKey = await getUserApiKey(db, userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) throw error(400, 'Add your ElevenLabs API key in Settings');

	const saved = await getUserVoiceSettings(db, userId);
	const settings = {
		...buildListenTtsSettings(saved, doc.voice_id, doc.tts_model),
		elevenlabs_tts_speed: genSpeed
	};
	const language = doc.language ?? undefined;
	const ctx = platform!.context;
	const waitUntil = (p: Promise<unknown>) => ctx.waitUntil(p.catch(() => undefined));

	const batch = state.pending.slice(0, batchSize);
	let generated = 0;
	let failure = '';

	// Awaited inside the request, not deferred to waitUntil: this work IS the response, so it
	// gets the invocation's full lifetime rather than the grace period after it.
	for (const sentence of batch) {
		try {
			await getOrSynthesizeSentence(
				db,
				platform!.env.MEDIA,
				platform!.env.KV,
				userId,
				apiKey,
				sentence.text,
				sentence.char_count,
				sentence.cacheHash,
				settings,
				language,
				waitUntil
			);
			generated++;
		} catch (err) {
			// Report partial progress rather than throwing it away. Everything synthesized so far
			// is already cached and billed; the client retries and only pays for the remainder.
			failure = err instanceof Error ? err.message : 'Synthesis failed';
			break;
		}
	}

	return json({
		generated,
		remaining: state.pending.length - generated,
		total,
		cached: state.cachedCount + generated,
		batchLimit: MAX_GENERATE_BATCH,
		...(failure ? { error: failure } : {})
	});
};

import { error } from '@sveltejs/kit';

/**
 * Rate-limit a per-user request bucket using KV. Implements a "fixed window" counter — the
 * window resets every `windowSec` seconds — which is good enough for "stop one user from
 * hammering an expensive endpoint" without needing a Durable Object. The worst case is a
 * brief 2× burst at a window boundary; for cost protection that's acceptable.
 *
 * Throws a 429 with a short message if the limit is exceeded. KV reads are eventually
 * consistent across isolates, so under a thundering-herd burst the actual count can drift
 * a bit above the limit — fine for soft protection, not for hard quota enforcement.
 *
 * Bucket names are namespaced so it's obvious in the KV browser which limiter a key belongs to.
 */
export async function enforceRateLimit(
	kv: KVNamespace,
	userId: string,
	bucket: string,
	limit: number,
	windowSec: number
): Promise<void> {
	const slot = Math.floor(Date.now() / 1000 / windowSec);
	const key = `rl:${bucket}:${userId}:${slot}`;
	const current = parseInt((await kv.get(key)) ?? '0', 10);
	if (current >= limit) {
		throw error(429, `Too many requests. Please slow down and try again in a moment.`);
	}
	// `expirationTtl` = 2× window so an in-flight slot doesn't get evicted prematurely under
	// clock skew between isolates. The slot key naturally rolls over so old slots fall out.
	await kv.put(key, String(current + 1), { expirationTtl: windowSec * 2 });
}

/**
 * Standard limits per endpoint. Chosen to be generous enough that no normal user hits them,
 * but tight enough that a compromised account can't burn unbounded ElevenLabs/Anthropic spend.
 * Tune in one place — the call sites just name a bucket.
 */
export const RATE_LIMITS = {
	/** Anthropic explain/hint — LLM calls are the most expensive per request. */
	anthropic_per_minute: { limit: 20, windowSec: 60 },
	/** OpenAI/ElevenLabs TTS during review — frequent enough during study but capped. */
	tts_per_minute: { limit: 60, windowSec: 60 },
	/** STT token minting — short-lived tokens, but each one costs a few cents in credit. */
	stt_token_per_minute: { limit: 30, windowSec: 60 },
	/**
	 * Listen stream opens. Per-stream API spend is already protected at the sentence layer
	 * (in-isolate dedupe + KV lock + cache + 2× real-time pacing), so this only needs to
	 * stop runaway connection churn — not bill flow. Set generously so normal pause/play/
	 * seek/speed-change interaction never bumps it (each of those opens a new stream).
	 */
	listen_stream_per_minute: { limit: 60, windowSec: 60 }
} as const;

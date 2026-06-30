/**
 * Short-lived capability tokens for out-of-band image upload. An authenticated MCP call mints a
 * token (so minting is gated by the MCP's OAuth); the agent then `curl`s the raw bytes to the
 * upload endpoint with that token in the path — the bytes travel over HTTPS, never through the
 * model context, and nothing has to be publicly hosted.
 *
 * Backed by KV (native TTL, and uploads are infrequent — not a hot path), so no DB migration.
 * The token grants only image writes into the minting user's own R2 namespace, size-capped, for a
 * short window, so a leaked token has a small, bounded blast radius.
 */
const KEY_PREFIX = 'media-upload:';

export const UPLOAD_TOKEN_TTL_SECONDS = 900; // 15 minutes
export const UPLOAD_TOKEN_MAX_USES = 50; // one mint covers a batch of slides

export interface UploadTokenMeta {
	userId: string;
	expiresAt: number;
	uses: number;
	maxUses: number;
}

function key(token: string): string {
	return KEY_PREFIX + token;
}

export async function mintUploadToken(kv: KVNamespace, userId: string, token: string): Promise<UploadTokenMeta> {
	const meta: UploadTokenMeta = {
		userId,
		expiresAt: Date.now() + UPLOAD_TOKEN_TTL_SECONDS * 1000,
		uses: 0,
		maxUses: UPLOAD_TOKEN_MAX_USES
	};
	await kv.put(key(token), JSON.stringify(meta), { expirationTtl: UPLOAD_TOKEN_TTL_SECONDS });
	return meta;
}

/**
 * Validate a token and atomically-enough count one use against it. Returns the owning userId on
 * success. KV's own TTL removes expired tokens; the explicit `expiresAt` check guards the window
 * regardless, and `maxUses` caps a single mint.
 */
export async function consumeUploadToken(
	kv: KVNamespace,
	token: string
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
	const raw = await kv.get(key(token));
	if (!raw) return { ok: false, error: 'Upload link is invalid or has expired.' };

	let meta: UploadTokenMeta;
	try {
		meta = JSON.parse(raw) as UploadTokenMeta;
	} catch {
		return { ok: false, error: 'Upload link is invalid.' };
	}

	if (Date.now() > meta.expiresAt) return { ok: false, error: 'Upload link has expired.' };
	if (meta.uses >= meta.maxUses) return { ok: false, error: 'Upload link has reached its use limit; mint a new one.' };

	const remainingTtl = Math.max(1, Math.ceil((meta.expiresAt - Date.now()) / 1000));
	await kv.put(key(token), JSON.stringify({ ...meta, uses: meta.uses + 1 }), { expirationTtl: remainingTtl });
	return { ok: true, userId: meta.userId };
}

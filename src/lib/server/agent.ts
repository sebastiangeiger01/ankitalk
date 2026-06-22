/**
 * ElevenLabs Conversational AI agent helpers.
 *
 * The user creates one "AnkiTalk Tutor" agent in their own ElevenLabs dashboard and pastes
 * the `agent_…` id into AnkiTalk settings. We mint short-lived signed URLs against it on
 * each session and pass per-conversation context via `dynamic_variables` and
 * `conversation_config_override` — the agent's own configuration in ElevenLabs doesn't
 * need to be tuned because we replace the prompt, voice, and language at conversation start.
 *
 * Docs:
 *  - https://elevenlabs.io/docs/api-reference/conversations/get-signed-url
 *  - https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables
 *
 * The signed URL is valid for 15 minutes from issuance; the conversation itself can run
 * longer once it's been initiated within that window.
 */

const SIGNED_URL_ENDPOINT = 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url';

export type SignedUrlResult =
	| { signedUrl: string }
	| { error: 'bad_agent' | 'bad_key' | 'rate_limited' | 'upstream' };

/**
 * Fetch a signed WebSocket URL for the given agent. Returns the bare URL on success;
 * surfaces a discriminated error on failure so the route can map it to a sensible 4xx/5xx
 * without leaking provider detail strings.
 */
export async function getSignedAgentUrl(apiKey: string, agentId: string): Promise<SignedUrlResult> {
	const url = new URL(SIGNED_URL_ENDPOINT);
	url.searchParams.set('agent_id', agentId);
	const res = await fetch(url, { headers: { 'xi-api-key': apiKey } });
	if (res.ok) {
		const body = (await res.json().catch(() => null)) as { signed_url?: string } | null;
		if (body?.signed_url) return { signedUrl: body.signed_url };
		return { error: 'upstream' };
	}
	if (res.status === 401 || res.status === 403) return { error: 'bad_key' };
	if (res.status === 404 || res.status === 400) return { error: 'bad_agent' };
	if (res.status === 429) return { error: 'rate_limited' };
	return { error: 'upstream' };
}

/**
 * Sanitize text destined for the agent's system prompt: collapse control characters and
 * cap length. We avoid HTML-stripping here because the deck text may legitimately contain
 * angle brackets (e.g. math notation, code) — the agent receives this as a string in a
 * structured dynamic variable, not as rendered HTML.
 */
const CONTROL_CHARS_REGEX = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');

export function sanitizeAgentContext(value: string, max: number): string {
	return value.replace(CONTROL_CHARS_REGEX, ' ').slice(0, max).trim();
}

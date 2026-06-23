/**
 * ElevenLabs Conversational AI agent helpers.
 *
 * The user creates one "AnkiTalk Tutor" agent in their own ElevenLabs dashboard and pastes
 * the `agent_…` id into AnkiTalk settings. We mint a short-lived WebRTC conversation token
 * against it on each session and pass per-conversation context via `dynamic_variables` and
 * `conversation_config_override` — the agent's own configuration in ElevenLabs doesn't
 * need to be tuned because we replace the prompt, voice, and language at conversation start.
 *
 * WebRTC (vs. a signed WebSocket URL) is ElevenLabs' lower-latency path, which matters most
 * for the first spoken turn of the tutor.
 *
 * Docs:
 *  - https://elevenlabs.io/docs/api-reference/conversations/get-conversation-token
 *  - https://elevenlabs.io/docs/agents-platform/customization/personalization/dynamic-variables
 */

const TOKEN_ENDPOINT = 'https://api.elevenlabs.io/v1/convai/conversation/token';

export type ConversationTokenResult =
	| { token: string }
	| { error: 'bad_agent' | 'bad_key' | 'rate_limited' | 'upstream' };

/**
 * Fetch a short-lived WebRTC conversation token for the given agent. Returns the bare token
 * on success; surfaces a discriminated error on failure so the route can map it to a sensible
 * 4xx/5xx without leaking provider detail strings.
 */
export async function getAgentConversationToken(apiKey: string, agentId: string): Promise<ConversationTokenResult> {
	const url = new URL(TOKEN_ENDPOINT);
	url.searchParams.set('agent_id', agentId);
	const res = await fetch(url, { headers: { 'xi-api-key': apiKey } });
	if (res.ok) {
		const body = (await res.json().catch(() => null)) as { token?: string } | null;
		if (body?.token) return { token: body.token };
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

export function getTutorAnswerContext(answer: string, answerRevealed: boolean, max: number): {
	answer: string;
	visibility: 'revealed' | 'hidden';
} {
	return answerRevealed
		? { answer: sanitizeAgentContext(answer, max), visibility: 'revealed' }
		: { answer: '[hidden until the student reveals the answer]', visibility: 'hidden' };
}

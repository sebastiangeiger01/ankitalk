import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getUserApiKey } from '$lib/server/user-keys';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import { getSignedAgentUrl, sanitizeAgentContext } from '$lib/server/agent';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/rate-limit';
import { requireField, normalizeLocale } from '$lib/server/validate';
import type { RequestHandler } from './$types';

/**
 * Maximum characters per dynamic variable. The agent platform doesn't publish a hard cap
 * but multi-thousand-char system prompts get expensive in LLM tokens fast. 4 KB per field
 * is roughly Anki-card-shaped (well above 99th-percentile card length) without bloating the
 * system prompt to where every conversation start costs serious tokens.
 */
const MAX_CONTEXT_FIELD = 4_000;

/**
 * The system prompt template is sent every conversation in `conversation_config_override`
 * so the user doesn't have to configure their agent in the ElevenLabs dashboard — they
 * just create any agent and paste its id. Variables are expanded server-side by ElevenLabs
 * from `dynamic_variables`. Plain-language, no markdown, because it's spoken aloud.
 */
const PROMPT_TEMPLATE_EN = `You are a patient one-on-one tutor helping a student understand an Anki flashcard.

The student is currently looking at this card:
Front (question): {{card_front}}
Back (answer): {{card_back}}
Deck: {{deck_name}}
Tags: {{tags}}

Speak in plain conversational English unless the student switches language. Keep answers under 30 seconds unless they explicitly ask for depth. Don't restate the card verbatim — add genuine context: the underlying principle, etymology, a real-world analogy, or a memorable example. If the student wants to move on, end gracefully so they can resume reviewing.`;

const PROMPT_TEMPLATE_DE = `Du bist ein geduldiger Eins-zu-eins-Tutor und hilfst einer studierenden Person, eine Anki-Karteikarte besser zu verstehen.

Die Person schaut sich gerade diese Karte an:
Vorderseite (Frage): {{card_front}}
Rückseite (Antwort): {{card_back}}
Stapel: {{deck_name}}
Tags: {{tags}}

Sprich in klarer Alltagssprache auf Deutsch, sofern die Person die Sprache nicht wechselt. Halte Antworten unter 30 Sekunden, sofern keine ausdrückliche Vertiefung gewünscht ist. Gib die Karte nicht einfach wieder — füge echten Kontext hinzu: das zugrunde liegende Prinzip, eine Etymologie, eine Analogie aus dem Alltag oder ein einprägsames Beispiel. Wenn die Person weiterlernen möchte, beende das Gespräch freundlich.`;

interface SessionRequest {
	front?: unknown;
	back?: unknown;
	deck_name?: unknown;
	tags?: unknown;
	locale?: unknown;
}

interface SessionResponse {
	signedUrl: string;
	dynamicVariables: Record<string, string | number | boolean>;
	systemPrompt: string;
	voiceId: string;
	language: 'en' | 'de';
}

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const userId = locals.userId;
	await enforceRateLimit(
		platform!.env.KV,
		userId,
		'agent_session',
		RATE_LIMITS.agent_session_per_minute.limit,
		RATE_LIMITS.agent_session_per_minute.windowSec
	);

	const body = (await request.json().catch(() => ({}))) as SessionRequest;
	const front = sanitizeAgentContext(requireField(body.front, 'front'), MAX_CONTEXT_FIELD);
	const back = sanitizeAgentContext(requireField(body.back, 'back'), MAX_CONTEXT_FIELD);
	const deckName = typeof body.deck_name === 'string' ? sanitizeAgentContext(body.deck_name, 200) : '';
	const tags = typeof body.tags === 'string' ? sanitizeAgentContext(body.tags, 500) : '';
	const locale = normalizeLocale(body.locale);

	const db = getDb(platform!);
	const settings = await getUserVoiceSettings(db, userId);
	if (!settings.elevenlabs_agent_id) {
		return json({ error: 'no_agent' }, { status: 400 });
	}

	const apiKey = await getUserApiKey(db, userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY);
	if (!apiKey) return json({ error: 'no_key' }, { status: 400 });

	const result = await getSignedAgentUrl(apiKey, settings.elevenlabs_agent_id);
	if ('error' in result) {
		const map: Record<string, number> = { bad_agent: 400, bad_key: 400, rate_limited: 429, upstream: 502 };
		return json({ error: result.error }, { status: map[result.error] ?? 502 });
	}

	const language: 'en' | 'de' = locale === 'de' ? 'de' : 'en';
	const systemPrompt = language === 'de' ? PROMPT_TEMPLATE_DE : PROMPT_TEMPLATE_EN;

	const payload: SessionResponse = {
		signedUrl: result.signedUrl,
		// Plain strings only — the agent platform supports string/number/integer/boolean and
		// we always stringify here so the system-prompt template doesn't render "[object …]"
		// if a deck name happens to be numeric.
		dynamicVariables: {
			card_front: front,
			card_back: back,
			deck_name: deckName || 'Anki',
			tags: tags || 'none'
		},
		systemPrompt,
		voiceId: settings.elevenlabs_voice_id,
		language
	};
	return json(payload);
};

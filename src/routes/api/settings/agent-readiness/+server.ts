import { error, json } from '@sveltejs/kit';
import { checkAgentReadiness, type AgentReadiness } from '$lib/server/agent-readiness';
import { getDb } from '$lib/server/db';
import { getUserApiKey } from '$lib/server/user-keys';
import { getUserVoiceSettings } from '$lib/server/voice-settings';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, platform, locals, fetch }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const [apiKey, settings] = await Promise.all([
		getUserApiKey(db, locals.userId, 'elevenlabs', platform!.env.ENCRYPTION_KEY),
		getUserVoiceSettings(db, locals.userId, 'en')
	]);

	if (!apiKey) {
		const result: AgentReadiness = {
			ready: false,
			issues: ['invalid_api_key'],
			agent: {
				configured: Boolean(settings.elevenlabs_agent_id),
				reachable: false,
				authentication_enabled: false,
				session_available: false,
				missing_overrides: []
			},
			mcp: { server_found: false, authenticated: false, assigned_to_agent: false, tools_found: [], missing_tools: [] }
		};
		return json(result, { headers: { 'cache-control': 'no-store' } });
	}

	const result = await checkAgentReadiness(
		apiKey,
		settings.elevenlabs_agent_id,
		`${url.origin}/api/mcp`,
		fetch
	);
	return json(result, { headers: { 'cache-control': 'no-store' } });
};

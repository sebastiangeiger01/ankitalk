import { describe, expect, it, vi } from 'vitest';
import { checkAgentReadiness, REQUIRED_STUDY_TOOLS } from './agent-readiness';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json' }
});

const readyAgent = {
	agent_id: 'agent-1',
	platform_settings: {
		auth: { enable_auth: true },
		overrides: {
			conversation_config_override: {
				agent: { first_message: true, language: true, prompt: { prompt: true } },
				tts: { voice_id: true }
			}
		}
	}
};

describe('checkAgentReadiness', () => {
	it('verifies the agent, MCP assignment, authentication, and required tools', async () => {
		const fetchFn = vi.fn()
			.mockResolvedValueOnce(response(readyAgent))
			.mockResolvedValueOnce(response({ signed_url: 'wss://api.elevenlabs.io/session' }))
			.mockResolvedValueOnce(response({ mcp_servers: [{ id: 'mcp-1', config: { url: 'https://staging.example/api/mcp/' }, dependent_agents: [{ id: 'agent-1' }] }] }))
			.mockResolvedValueOnce(response({ id: 'mcp-1', config: { url: 'https://staging.example/api/mcp' }, dependent_agents: [{ id: 'agent-1' }] }))
			.mockResolvedValueOnce(response({ tools: REQUIRED_STUDY_TOOLS.map((name) => ({ name })) }));

		const result = await checkAgentReadiness('secret', 'agent-1', 'https://staging.example/api/mcp', fetchFn);

		expect(result.ready).toBe(true);
		expect(result.issues).toEqual([]);
		expect(result.agent.session_available).toBe(true);
		expect(result.mcp.tools_found).toEqual(REQUIRED_STUDY_TOOLS);
	});

	it('reports when no MCP server has the staging endpoint', async () => {
		const fetchFn = vi.fn()
			.mockResolvedValueOnce(response(readyAgent))
			.mockResolvedValueOnce(response({ signed_url: 'wss://api.elevenlabs.io/session' }))
			.mockResolvedValueOnce(response({ mcp_servers: [] }));

		const result = await checkAgentReadiness('secret', 'agent-1', 'https://staging.example/api/mcp', fetchFn);

		expect(result.issues).toContain('mcp_server_not_found');
		expect(result.mcp.server_found).toBe(false);
	});

	it('distinguishes an unassigned server and failed MCP authentication', async () => {
		const fetchFn = vi.fn()
			.mockResolvedValueOnce(response(readyAgent))
			.mockResolvedValueOnce(response({ signed_url: 'wss://api.elevenlabs.io/session' }))
			.mockResolvedValueOnce(response({ mcp_servers: [{ id: 'mcp-1', config: { url: 'https://staging.example/api/mcp' }, dependent_agents: [] }] }))
			.mockResolvedValueOnce(response({ id: 'mcp-1', dependent_agents: [] }))
			.mockResolvedValueOnce(response({}, 424));

		const result = await checkAgentReadiness('secret', 'agent-1', 'https://staging.example/api/mcp', fetchFn);

		expect(result.issues).toEqual(['mcp_not_assigned', 'mcp_auth_failed']);
	});

	it('reports API-key permissions before probing MCP', async () => {
		const fetchFn = vi.fn().mockResolvedValueOnce(response({}, 403));
		const result = await checkAgentReadiness('secret', 'agent-1', 'https://staging.example/api/mcp', fetchFn);
		expect(result.issues).toEqual(['insufficient_permissions']);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it('treats a 200 tool-discovery response with success false as an auth failure', async () => {
		const fetchFn = vi.fn()
			.mockResolvedValueOnce(response(readyAgent))
			.mockResolvedValueOnce(response({ signed_url: 'wss://api.elevenlabs.io/session' }))
			.mockResolvedValueOnce(response({ mcp_servers: [{ id: 'mcp-1', config: { url: 'https://staging.example/api/mcp' }, dependent_agents: [{ id: 'agent-1' }] }] }))
			.mockResolvedValueOnce(response({ id: 'mcp-1', dependent_agents: [{ id: 'agent-1' }] }))
			.mockResolvedValueOnce(response({ success: false, tools: [], error_message: 'Unauthorized' }));

		const result = await checkAgentReadiness('secret', 'agent-1', 'https://staging.example/api/mcp', fetchFn);
		expect(result.issues).toEqual(['mcp_auth_failed']);
		expect(result.mcp.authenticated).toBe(false);
	});

	it('continues checking MCP when an authenticated agent cannot create session credentials', async () => {
		const fetchFn = vi.fn()
			.mockResolvedValueOnce(response(readyAgent))
			.mockResolvedValueOnce(response({}, 500))
			.mockResolvedValueOnce(response({ mcp_servers: [] }));

		const result = await checkAgentReadiness('secret', 'agent-1', 'https://staging.example/api/mcp', fetchFn);
		expect(result.ready).toBe(false);
		expect(result.agent.session_available).toBe(false);
		expect(result.issues).toEqual(['agent_session_unavailable', 'mcp_server_not_found']);
		expect(fetchFn).toHaveBeenCalledTimes(3);
	});

	it('maps a 401 from the signed-url endpoint to insufficient permissions, not an unavailable session', async () => {
		const fetchFn = vi.fn()
			.mockResolvedValueOnce(response(readyAgent))
			.mockResolvedValueOnce(response({}, 401))
			.mockResolvedValueOnce(response({ mcp_servers: [] }));

		const result = await checkAgentReadiness('secret', 'agent-1', 'https://staging.example/api/mcp', fetchFn);

		expect(result.agent.session_available).toBe(false);
		expect(result.issues).toEqual(['insufficient_permissions', 'mcp_server_not_found']);
	});

	it('explains disabled agent authentication and missing overrides while still checking MCP', async () => {
		const fetchFn = vi.fn()
			.mockResolvedValueOnce(response({
				agent_id: 'agent-1',
				platform_settings: {
					auth: { enable_auth: false },
					overrides: { conversation_config_override: {} }
				}
			}))
			.mockResolvedValueOnce(response({ mcp_servers: [] }));

		const result = await checkAgentReadiness('secret', 'agent-1', 'https://staging.example/api/mcp', fetchFn);

		expect(result.agent.authentication_enabled).toBe(false);
		expect(result.agent.missing_overrides).toEqual(['prompt', 'first_message', 'language', 'voice_id']);
		expect(result.issues).toEqual([
			'agent_auth_disabled',
			'agent_overrides_missing',
			'mcp_server_not_found'
		]);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});
});

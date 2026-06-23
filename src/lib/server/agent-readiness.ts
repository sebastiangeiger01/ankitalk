const ELEVENLABS_API = 'https://api.elevenlabs.io/v1/convai';

export const REQUIRED_STUDY_TOOLS = [
	'get_card_context',
	'search_study_material',
	'find_cards',
	'get_study_progress'
] as const;

export type AgentReadinessIssue =
	| 'agent_not_configured'
	| 'agent_not_found'
	| 'invalid_api_key'
	| 'insufficient_permissions'
	| 'mcp_server_not_found'
	| 'mcp_auth_failed'
	| 'mcp_not_assigned'
	| 'mcp_tools_missing'
	| 'elevenlabs_unavailable';

export interface AgentReadiness {
	ready: boolean;
	issues: AgentReadinessIssue[];
	agent: { configured: boolean; reachable: boolean };
	mcp: {
		server_found: boolean;
		authenticated: boolean;
		assigned_to_agent: boolean;
		tools_found: string[];
		missing_tools: string[];
	};
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function normalizeUrl(value: string): string {
	return value.trim().replace(/\/+$/, '');
}

function records(value: unknown, keys: string[]): Record<string, unknown>[] {
	if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
	if (!value || typeof value !== 'object') return [];
	const record = value as Record<string, unknown>;
	for (const key of keys) {
		if (Array.isArray(record[key])) return records(record[key], []);
	}
	return [];
}

function toolNames(value: unknown): string[] {
	return records(value, ['tools']).flatMap((tool) => {
		const config = tool.tool_config && typeof tool.tool_config === 'object'
			? tool.tool_config as Record<string, unknown>
			: undefined;
		const name = tool.name ?? config?.name;
		return typeof name === 'string' ? [name] : [];
	});
}

function dependentAgentIds(server: Record<string, unknown>): string[] {
	return records(server.dependent_agents, []).flatMap((agent) => {
		const id = agent.id ?? agent.agent_id;
		return typeof id === 'string' ? [id] : [];
	});
}

function serverUrl(server: Record<string, unknown>): string | null {
	const config = server.config && typeof server.config === 'object'
		? server.config as Record<string, unknown>
		: undefined;
	const value = config?.url ?? server.url;
	return typeof value === 'string' ? value : null;
}

function emptyReadiness(issue: AgentReadinessIssue, configured: boolean): AgentReadiness {
	return {
		ready: false,
		issues: [issue],
		agent: { configured, reachable: false },
		mcp: { server_found: false, authenticated: false, assigned_to_agent: false, tools_found: [], missing_tools: [...REQUIRED_STUDY_TOOLS] }
	};
}

async function jsonBody(response: Response): Promise<unknown> {
	return response.json().catch(() => null);
}

export async function checkAgentReadiness(
	apiKey: string,
	agentId: string | null,
	expectedMcpUrl: string,
	fetchFn: FetchLike = fetch
): Promise<AgentReadiness> {
	if (!agentId?.trim()) return emptyReadiness('agent_not_configured', false);

	const headers = { 'xi-api-key': apiKey };
	let agentResponse: Response;
	try {
		agentResponse = await fetchFn(`${ELEVENLABS_API}/agents/${encodeURIComponent(agentId)}`, { headers });
	} catch {
		return emptyReadiness('elevenlabs_unavailable', true);
	}
	if (agentResponse.status === 401) return emptyReadiness('invalid_api_key', true);
	if (agentResponse.status === 403) return emptyReadiness('insufficient_permissions', true);
	if (agentResponse.status === 404) return emptyReadiness('agent_not_found', true);
	if (!agentResponse.ok) return emptyReadiness('elevenlabs_unavailable', true);

	const result: AgentReadiness = {
		ready: false,
		issues: [],
		agent: { configured: true, reachable: true },
		mcp: { server_found: false, authenticated: false, assigned_to_agent: false, tools_found: [], missing_tools: [...REQUIRED_STUDY_TOOLS] }
	};

	let listResponse: Response;
	try {
		listResponse = await fetchFn(`${ELEVENLABS_API}/mcp-servers`, { headers });
	} catch {
		result.issues.push('elevenlabs_unavailable');
		return result;
	}
	if (listResponse.status === 401) result.issues.push('invalid_api_key');
	else if (listResponse.status === 403) result.issues.push('insufficient_permissions');
	else if (!listResponse.ok) result.issues.push('elevenlabs_unavailable');
	if (!listResponse.ok) return result;

	const servers = records(await jsonBody(listResponse), ['mcp_servers', 'servers']);
	const expectedUrl = normalizeUrl(expectedMcpUrl);
	const server = servers.find((candidate) => {
		const candidateUrl = serverUrl(candidate);
		return candidateUrl !== null && normalizeUrl(candidateUrl) === expectedUrl;
	});
	if (!server) {
		result.issues.push('mcp_server_not_found');
		return result;
	}
	result.mcp.server_found = true;

	const serverId = server.id ?? server.mcp_server_id;
	if (typeof serverId !== 'string') {
		result.issues.push('elevenlabs_unavailable');
		return result;
	}

	let detail = server;
	try {
		const detailResponse = await fetchFn(`${ELEVENLABS_API}/mcp-servers/${encodeURIComponent(serverId)}`, { headers });
		if (detailResponse.ok) {
			const body = await jsonBody(detailResponse);
			if (body && typeof body === 'object') detail = body as Record<string, unknown>;
		}
	} catch {
		// The list response normally contains dependent_agents; keep using it.
	}
	result.mcp.assigned_to_agent = dependentAgentIds(detail).includes(agentId);
	if (!result.mcp.assigned_to_agent) result.issues.push('mcp_not_assigned');

	let toolsResponse: Response;
	try {
		toolsResponse = await fetchFn(`${ELEVENLABS_API}/mcp-servers/${encodeURIComponent(serverId)}/tools`, { headers });
	} catch {
		result.issues.push('mcp_auth_failed');
		return result;
	}
	if (!toolsResponse.ok) {
		result.issues.push(toolsResponse.status === 403 ? 'insufficient_permissions' : 'mcp_auth_failed');
		return result;
	}
	const toolsBody = await jsonBody(toolsResponse);
	if (toolsBody && typeof toolsBody === 'object' && (toolsBody as Record<string, unknown>).success === false) {
		result.issues.push('mcp_auth_failed');
		return result;
	}
	result.mcp.authenticated = true;
	result.mcp.tools_found = toolNames(toolsBody);
	result.mcp.missing_tools = REQUIRED_STUDY_TOOLS.filter((name) => !result.mcp.tools_found.includes(name));
	if (result.mcp.missing_tools.length) result.issues.push('mcp_tools_missing');

	result.ready = result.issues.length === 0;
	return result;
}

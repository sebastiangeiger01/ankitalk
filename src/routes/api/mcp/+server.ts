import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import {
	ErrorCode,
	failure,
	isJsonRpcRequest,
	isNotification,
	MCP_PROTOCOL_VERSION,
	success,
	type JsonRpcRequest,
	type JsonRpcResponse
} from '$lib/server/mcp/protocol';
import { TOOLS, findTool, type ToolContext } from '$lib/server/mcp/tools';
import {
	extractBearer,
	resolveTokenOwner,
	touchLastUsed
} from '$lib/server/mcp/auth';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/rate-limit';

/**
 * MCP (Model Context Protocol) Streamable HTTP endpoint.
 *
 * Auth: `Authorization: Bearer mcp_<…>`. Tokens are created and revoked from
 * Settings → MCP and validated against the hashed copy in `mcp_tokens`. The token
 * carries no user_id directly — we look it up by hash on every call.
 *
 * Transport: only the JSON-response branch of Streamable HTTP. We never upgrade to SSE
 * because Cloudflare Workers don't keep persistent connections cheaply and the spec
 * explicitly allows JSON-only responses for tool servers without server-initiated
 * notifications. Clients (including ElevenLabs agents) MUST handle both per the spec.
 *
 * Supported methods: `initialize`, `notifications/initialized`, `tools/list`,
 * `tools/call`, `ping`. Everything else returns -32601 (method not found).
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18
 */
export const POST: RequestHandler = async ({ request, platform }) => {
	const auth = extractBearer(request.headers.get('Authorization'));
	if (!auth) {
		return new Response(
			JSON.stringify(failure(null, ErrorCode.InvalidRequest, 'Missing Bearer token')),
			{ status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' } }
		);
	}

	const db = getDb(platform!);
	const owner = await resolveTokenOwner(db, auth);
	if (!owner) {
		return new Response(
			JSON.stringify(failure(null, ErrorCode.InvalidRequest, 'Invalid token')),
			{ status: 401, headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' } }
		);
	}

	// Rate-limit MCP calls per token-holder. Tools touch D1 + sometimes the LLM, so a
	// runaway agent or a leaked token shouldn't be able to hammer us.
	try {
		await enforceRateLimit(
			platform!.env.KV,
			owner.userId,
			'mcp_call',
			RATE_LIMITS.mcp_call_per_minute.limit,
			RATE_LIMITS.mcp_call_per_minute.windowSec
		);
	} catch (err) {
		// enforceRateLimit throws a SvelteKit `error()` (HttpError); we want to return a
		// proper JSON-RPC error envelope, not an HTML error page. Catch and reshape.
		const status = (err as { status?: number })?.status === 429 ? 429 : 500;
		return new Response(
			JSON.stringify(failure(null, ErrorCode.InternalError, 'Rate limit exceeded')),
			{ status, headers: { 'Content-Type': 'application/json' } }
		);
	}

	// Update last_used_at non-blocking — it's purely informational for the settings UI.
	platform?.context?.waitUntil(touchLastUsed(db, owner.tokenId).catch(() => undefined));

	const raw = await request.json().catch(() => null);
	if (!isJsonRpcRequest(raw)) {
		return new Response(
			JSON.stringify(failure(null, ErrorCode.ParseError, 'Invalid JSON-RPC envelope')),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		);
	}

	const ctx: ToolContext = {
		db,
		userId: owner.userId,
		encryptionKey: platform!.env.ENCRYPTION_KEY
	};
	const response = await dispatch(raw, ctx);
	if (response === null) {
		// Notifications: 202 with empty body per the spec.
		return new Response(null, { status: 202 });
	}
	return new Response(JSON.stringify(response), {
		status: 200,
		headers: { 'Content-Type': 'application/json' }
	});
};

async function dispatch(req: JsonRpcRequest, ctx: ToolContext): Promise<JsonRpcResponse | null> {
	const notification = isNotification(req);

	switch (req.method) {
		case 'initialize':
			return success(req.id, {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {
					tools: { listChanged: false }
				},
				serverInfo: {
					name: 'ankitalk-mcp',
					version: '1.0.0',
					title: 'AnkiTalk'
				},
				instructions:
					'Tools for inspecting an AnkiTalk user\'s decks, cards, and review history. All operations are user-scoped via the bearer token. Useful for tutoring and review-context retrieval.'
			});

		case 'notifications/initialized':
			// Spec: notifications must return 202 with no body.
			return null;

		case 'ping':
			return notification ? null : success(req.id, {});

		case 'tools/list':
			return success(req.id, {
				tools: TOOLS.map((t) => ({
					name: t.name,
					description: t.description,
					inputSchema: t.inputSchema
				}))
			});

		case 'tools/call': {
			const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
			if (typeof params.name !== 'string') {
				return failure(req.id, ErrorCode.InvalidParams, 'tools/call requires a string `name`');
			}
			const tool = findTool(params.name);
			if (!tool) {
				return failure(req.id, ErrorCode.MethodNotFound, `Unknown tool: ${params.name}`);
			}
			const args = (params.arguments ?? {}) as Record<string, unknown>;
			try {
				const result = await tool.handler(args, ctx);
				return success(req.id, result);
			} catch (e) {
				const message = e instanceof Error ? e.message : 'Tool execution failed';
				// Tool-execution errors go inside the result envelope with isError=true,
				// not as a JSON-RPC protocol error — that's the MCP convention so the LLM
				// sees them as content rather than connection failures.
				return success(req.id, {
					content: [{ type: 'text', text: message }],
					isError: true
				});
			}
		}

		default:
			if (notification) return null;
			return failure(req.id, ErrorCode.MethodNotFound, `Unknown method: ${req.method}`);
	}
}

/**
 * GET on the endpoint is the SSE upgrade path per the streamable-HTTP spec. We don't
 * support server-initiated notifications, so reply 405 — the spec explicitly allows
 * this and instructs clients to fall back to POST-only behavior.
 */
export const GET: RequestHandler = async () => {
	return new Response('SSE stream not supported; use POST', {
		status: 405,
		headers: { Allow: 'POST' }
	});
};

/** DELETE for explicit session termination. We're stateless, so just acknowledge. */
export const DELETE: RequestHandler = async () => {
	return new Response(null, { status: 204 });
};

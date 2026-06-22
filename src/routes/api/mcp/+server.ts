import type { RequestHandler } from './$types';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { getDb } from '$lib/server/db';
import { createMcpServer } from '$lib/server/mcp/tools';
import { extractBearer, resolveTokenOwner, touchLastUsed } from '$lib/server/mcp/auth';
import { enforceRateLimit, RATE_LIMITS } from '$lib/server/rate-limit';

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

function rpcError(status: number, code: number, message: string, authenticate = false) {
	const headers = new Headers(JSON_HEADERS);
	if (authenticate) headers.set('WWW-Authenticate', 'Bearer realm="AnkiTalk MCP"');
	return new Response(
		JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }),
		{ status, headers }
	);
}

function originAllowed(request: Request, requestOrigin: string): boolean {
	const origin = request.headers.get('Origin');
	// Remote server clients normally omit Origin. When a browser supplies it, MCP
	// requires validation to prevent DNS-rebinding and confused-deputy attacks.
	return !origin || origin === requestOrigin;
}

const handleMcp: RequestHandler = async ({ request, url, platform }) => {
	if (!originAllowed(request, url.origin)) {
		return rpcError(403, -32600, 'Invalid Origin');
	}

	const plaintext = extractBearer(request.headers.get('Authorization'));
	if (!plaintext) return rpcError(401, -32001, 'Missing bearer token', true);

	const db = getDb(platform!);
	const owner = await resolveTokenOwner(db, plaintext);
	if (!owner) return rpcError(401, -32001, 'Invalid or expired bearer token', true);

	try {
		await enforceRateLimit(
			platform!.env.KV,
			owner.tokenId,
			'mcp_call',
			RATE_LIMITS.mcp_call_per_minute.limit,
			RATE_LIMITS.mcp_call_per_minute.windowSec
		);
	} catch (error) {
		const status = (error as { status?: number }).status === 429 ? 429 : 500;
		return rpcError(status, -32603, status === 429 ? 'Rate limit exceeded' : 'Rate limiter unavailable');
	}

	platform!.context.waitUntil(touchLastUsed(db, owner.tokenId).catch(() => undefined));
	const server = createMcpServer({
		db,
		userId: owner.userId,
		tokenId: owner.tokenId,
		scopes: owner.scopes,
		waitUntil: (promise) => platform!.context.waitUntil(promise.catch(() => undefined))
	});
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true
	});
	await server.connect(transport);
	const response = await transport.handleRequest(request, {
		authInfo: {
			token: owner.tokenId,
			clientId: owner.tokenId,
			scopes: [...owner.scopes]
		}
	});
	response.headers.set('Cache-Control', 'no-store');
	return response;
};

export const POST = handleMcp;
export const GET = handleMcp;
export const DELETE = handleMcp;

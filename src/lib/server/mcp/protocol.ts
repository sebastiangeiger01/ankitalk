/**
 * Lightweight JSON-RPC 2.0 + MCP envelope helpers.
 *
 * We implement only what the Streamable HTTP transport needs for tool-only servers:
 * `initialize`, `tools/list`, `tools/call`, and the `notifications/initialized`
 * acknowledgement. No SSE, no resources, no prompts, no sampling. The MCP spec allows
 * this minimal subset — clients that need more will see the empty capability set in the
 * initialize response and degrade gracefully.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Standard JSON-RPC 2.0 error codes plus MCP-specific extensions. */
export const ErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603
} as const;

export interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: string | number | null;
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: string | number | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	return v.jsonrpc === '2.0' && typeof v.method === 'string';
}

/** A notification is a JSON-RPC request without an `id` — the client expects no response. */
export function isNotification(req: JsonRpcRequest): boolean {
	return req.id === undefined || req.id === null;
}

export function success(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id: id ?? null, result };
}

export function failure(
	id: JsonRpcRequest['id'],
	code: number,
	message: string,
	data?: unknown
): JsonRpcResponse {
	return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

/**
 * Tool result content block. We only emit text content for now — image content from an
 * MCP server flows in MCP-aware clients (Claude Desktop etc.); ElevenLabs agents render
 * tool results as text regardless, so emitting image blocks would be wasted bytes.
 */
export interface TextContent {
	type: 'text';
	text: string;
}

export interface ToolResult {
	content: TextContent[];
	isError?: boolean;
	/** Optional machine-readable mirror of `content`. Useful for clients that prefer JSON. */
	structuredContent?: unknown;
}

export function textResult(text: string, structured?: unknown): ToolResult {
	return {
		content: [{ type: 'text', text }],
		...(structured !== undefined ? { structuredContent: structured } : {})
	};
}

export function errorResult(message: string): ToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

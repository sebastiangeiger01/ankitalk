import { json } from '@sveltejs/kit';
import { protectedResourceMetadata } from '$lib/server/mcp/oauth';
import type { RequestHandler } from './$types';

/**
 * RFC 9728 Protected Resource Metadata. MCP clients discover this from the `WWW-Authenticate`
 * header our /api/mcp endpoint returns on 401. The `[...path]` rest segment lets both the bare
 * `/.well-known/oauth-protected-resource` and the resource-suffixed
 * `/.well-known/oauth-protected-resource/api/mcp` forms resolve to the same document.
 */
const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': '*'
};

export const GET: RequestHandler = async ({ url }) => {
	return json(protectedResourceMetadata(url.origin), {
		headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' }
	});
};

export const OPTIONS: RequestHandler = async () => new Response(null, { status: 204, headers: CORS });

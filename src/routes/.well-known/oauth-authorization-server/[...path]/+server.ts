import { json } from '@sveltejs/kit';
import { authorizationServerMetadata } from '$lib/server/mcp/oauth';
import type { RequestHandler } from './$types';

/**
 * RFC 8414 Authorization Server Metadata. AnkiTalk is both the resource server and its own
 * authorization server, so this advertises our authorize/token/registration endpoints and the
 * PKCE method we require. The `[...path]` rest segment tolerates clients that append the
 * resource path to the well-known URL.
 */
const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': '*'
};

export const GET: RequestHandler = async ({ url }) => {
	return json(authorizationServerMetadata(url.origin), {
		headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' }
	});
};

export const OPTIONS: RequestHandler = async () => new Response(null, { status: 204, headers: CORS });

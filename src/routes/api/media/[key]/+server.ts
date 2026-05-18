import { error } from '@sveltejs/kit';
import {
	isSafeMediaFilename,
	isSvgMediaFilename,
	mediaContentTypeForFilename,
	svgMediaContentSecurityPolicy
} from '$lib/sanitize';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	if (!isSafeMediaFilename(params.key)) throw error(400, 'Invalid key');
	const contentType = mediaContentTypeForFilename(params.key);
	if (!contentType) throw error(400, 'Unsupported media type');

	const r2Key = `${locals.userId}/${params.key}`;
	const object = await platform!.env.MEDIA.get(r2Key);

	if (!object) throw error(404, 'Media not found');

	const headers = new Headers();
	headers.set('Content-Type', contentType);
	headers.set('Cache-Control', 'public, max-age=31536000, immutable');
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('Cross-Origin-Resource-Policy', 'same-origin');
	if (isSvgMediaFilename(params.key)) {
		headers.set('Content-Security-Policy', svgMediaContentSecurityPolicy());
	}

	return new Response(object.body, { headers });
};

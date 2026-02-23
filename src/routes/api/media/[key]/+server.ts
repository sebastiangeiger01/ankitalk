import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	if (params.key.includes('..')) throw error(400, 'Invalid key');
	const r2Key = `${locals.userId}/${params.key}`;
	const object = await platform!.env.MEDIA.get(r2Key);

	if (!object) throw error(404, 'Media not found');

	const headers = new Headers();
	headers.set(
		'Content-Type',
		object.httpMetadata?.contentType ?? 'application/octet-stream'
	);
	headers.set('Cache-Control', 'public, max-age=31536000, immutable');

	return new Response(object.body, { headers });
};

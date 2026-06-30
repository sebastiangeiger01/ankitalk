import { json, error } from '@sveltejs/kit';
import { IMPORT_LIMITS } from '$lib/sanitize';
import { isImageFilename, imageTypeError, storeUserImage } from '$lib/server/media-store';
import { consumeUploadToken } from '$lib/server/media-upload-token';
import type { RequestHandler } from './$types';

/**
 * Out-of-band image upload. The agent obtains the URL+token from the `create_image_upload_link` MCP
 * tool, then PUTs the raw image bytes here (e.g. `curl --data-binary @file`). No session cookie or
 * bearer is needed — the path token is the capability. The `filename` query parameter supplies the
 * extension (which selects the raster-vs-SVG sanitize branch); the stored name is content-addressed.
 */
export const PUT: RequestHandler = async ({ params, url, request, platform }) => {
	const filename = url.searchParams.get('filename');
	if (!filename) throw error(400, 'Missing ?filename query parameter');
	if (!isImageFilename(filename)) throw error(415, imageTypeError(filename));

	const consumed = await consumeUploadToken(platform!.env.KV, params.token);
	if (!consumed.ok) throw error(401, consumed.error);

	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength === 0) throw error(400, 'Empty request body');
	if (bytes.byteLength > IMPORT_LIMITS.maxMediaFileBytes) throw error(413, 'Image is too large');

	try {
		const stored = await storeUserImage(platform!.env.MEDIA, consumed.userId, filename, bytes);
		return json({ ...stored, url: `/api/media/${encodeURIComponent(stored.filename)}` }, { status: 201 });
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : 'Could not store image');
	}
};

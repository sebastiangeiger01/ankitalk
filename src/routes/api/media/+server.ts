import { json, error } from '@sveltejs/kit';
import { IMPORT_LIMITS } from '$lib/sanitize';
import { isImageFilename, imageTypeError, storeUserImage } from '$lib/server/media-store';
import type { RequestHandler } from './$types';

/**
 * Upload one image for the current user, to be embedded in a card field as
 * `<img src="<returned filename>">`. Accepts multipart/form-data with a single `file` field.
 * Raster images and (sanitized) SVG are allowed; the stored filename is content-addressed.
 */
export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		throw error(400, 'Expected multipart/form-data');
	}

	const file = form.get('file');
	if (!(file instanceof File)) throw error(400, 'Missing file');
	if (!isImageFilename(file.name)) throw error(415, imageTypeError(file.name));
	if (file.size > IMPORT_LIMITS.maxMediaFileBytes) throw error(413, 'Image is too large');

	const bytes = new Uint8Array(await file.arrayBuffer());

	try {
		const stored = await storeUserImage(platform!.env.MEDIA, locals.userId, file.name, bytes);
		return json({ ...stored, url: `/api/media/${encodeURIComponent(stored.filename)}` }, { status: 201 });
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : 'Could not store image');
	}
};

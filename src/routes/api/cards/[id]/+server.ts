import { json, error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { sanitizeNoteFields, sanitizeNoteTags } from '$lib/server/note-fields';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = async ({ params, request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const body = (await request.json()) as {
		fields: { name: string; value: string }[];
		tags?: string;
	};

	if (!body.fields || body.fields.length === 0) {
		throw error(400, 'Fields are required');
	}
	// Same validation/sanitization as the import path — size limits + HTML sanitization.
	const fields = sanitizeNoteFields(body.fields);

	const db = getDb(platform!);

	// Fetch card to get note_id
	const card = await db
		.prepare('SELECT note_id FROM cards WHERE id = ? AND user_id = ?')
		.bind(params.id, locals.userId)
		.first<{ note_id: string }>();

	if (!card) throw error(404, 'Card not found');

	// Update the note
	const updates: string[] = ["fields = ?"];
	const binds: (string | null)[] = [JSON.stringify(fields)];

	if (body.tags !== undefined) {
		updates.push("tags = ?");
		binds.push(sanitizeNoteTags(body.tags));
	}

	await db
		.prepare(`UPDATE notes SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`)
		.bind(...binds, card.note_id, locals.userId)
		.run();

	return json({ updated: true });
};

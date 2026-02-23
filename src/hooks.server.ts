import { redirect, type Handle } from '@sveltejs/kit';
import { verifyHankoToken } from '$lib/server/auth';
import { getDb, newId } from '$lib/server/db';

const PUBLIC_PATHS = ['/login', '/api/deepgram-token'];

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.userId = null;

	const hankoApiUrl = event.platform?.env.HANKO_API_URL;
	if (!hankoApiUrl) {
		// No auth configured yet — allow passthrough for dev
		return resolve(event);
	}

	const token = event.cookies.get('hanko');
	const hankoId = await verifyHankoToken(token, hankoApiUrl);

	if (hankoId) {
		// Upsert user in D1
		const db = getDb(event.platform!);
		const existing = await db
			.prepare('SELECT id FROM users WHERE hanko_id = ?')
			.bind(hankoId)
			.first<{ id: string }>();

		if (existing) {
			event.locals.userId = existing.id;
			await db
				.prepare("UPDATE users SET updated_at = datetime('now') WHERE id = ?")
				.bind(existing.id)
				.run();
		} else {
			const userId = newId();
			await db
				.prepare('INSERT INTO users (id, hanko_id) VALUES (?, ?)')
				.bind(userId, hankoId)
				.run();
			event.locals.userId = userId;
		}
	}

	// Protect non-public paths
	const isPublic = PUBLIC_PATHS.some((p) => event.url.pathname.startsWith(p));
	if (!hankoId && !isPublic) {
		throw redirect(303, '/login');
	}

	return resolve(event);
};

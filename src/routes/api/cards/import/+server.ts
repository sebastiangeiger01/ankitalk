import { json, error } from '@sveltejs/kit';
import { getDb, newId } from '$lib/server/db';
import type { RequestHandler } from './$types';

interface ImportDeck {
	ankiId: number;
	name: string;
}

interface ImportNote {
	ankiId: number;
	modelName: string;
	fields: { name: string; value: string }[];
	tags: string;
	deckId: number;
}

interface ImportCard {
	ankiId: number;
	noteAnkiId: number;
	deckAnkiId: number;
	ordinal: number;
	cardType: 'basic' | 'cloze';
}

const BATCH_SIZE = 500;

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const userId = locals.userId;

	const formData = await request.formData();
	const dataStr = formData.get('data');
	if (!dataStr || typeof dataStr !== 'string') {
		throw error(400, 'Missing data field');
	}

	const { decks, notes, cards } = JSON.parse(dataStr) as {
		decks: ImportDeck[];
		notes: ImportNote[];
		cards: ImportCard[];
	};

	// Build ID mappings: Anki ID → UUID
	const deckIdMap = new Map<number, string>();
	const noteIdMap = new Map<number, string>();

	// Create decks
	const deckStmts: D1PreparedStatement[] = [];
	for (const deck of decks) {
		const id = newId();
		deckIdMap.set(deck.ankiId, id);
		deckStmts.push(
			db
				.prepare(
					'INSERT INTO decks (id, user_id, anki_id, name, card_count) VALUES (?, ?, ?, ?, 0)'
				)
				.bind(id, userId, deck.ankiId, deck.name)
		);
	}

	if (deckStmts.length > 0) {
		await db.batch(deckStmts);
	}

	// Create notes in batches
	const noteStmts: D1PreparedStatement[] = [];
	for (const note of notes) {
		const id = newId();
		noteIdMap.set(note.ankiId, id);
		const deckUuid = deckIdMap.get(note.deckId) ?? Array.from(deckIdMap.values())[0];
		noteStmts.push(
			db
				.prepare(
					'INSERT INTO notes (id, user_id, deck_id, anki_id, model_name, fields, tags) VALUES (?, ?, ?, ?, ?, ?, ?)'
				)
				.bind(
					id,
					userId,
					deckUuid,
					note.ankiId,
					note.modelName,
					JSON.stringify(note.fields),
					note.tags
				)
		);
	}

	for (let i = 0; i < noteStmts.length; i += BATCH_SIZE) {
		await db.batch(noteStmts.slice(i, i + BATCH_SIZE));
	}

	// Create cards in batches
	const cardStmts: D1PreparedStatement[] = [];
	const deckCardCounts = new Map<string, number>();

	for (const card of cards) {
		const id = newId();
		const noteUuid = noteIdMap.get(card.noteAnkiId);
		const deckUuid = deckIdMap.get(card.deckAnkiId) ?? Array.from(deckIdMap.values())[0];

		if (!noteUuid || !deckUuid) continue;

		deckCardCounts.set(deckUuid, (deckCardCounts.get(deckUuid) ?? 0) + 1);

		cardStmts.push(
			db
				.prepare(
					'INSERT INTO cards (id, user_id, deck_id, note_id, anki_id, ordinal, card_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
				)
				.bind(id, userId, deckUuid, noteUuid, card.ankiId, card.ordinal, card.cardType)
		);
	}

	for (let i = 0; i < cardStmts.length; i += BATCH_SIZE) {
		await db.batch(cardStmts.slice(i, i + BATCH_SIZE));
	}

	// Update deck card counts
	const countStmts: D1PreparedStatement[] = [];
	for (const [deckId, count] of deckCardCounts) {
		countStmts.push(
			db.prepare('UPDATE decks SET card_count = ? WHERE id = ?').bind(count, deckId)
		);
	}
	if (countStmts.length > 0) {
		await db.batch(countStmts);
	}

	// Upload media files to R2
	const mediaKeys: string[] = [];
	for (const [key, value] of formData.entries()) {
		if (key.startsWith('media-')) {
			const filename = key.slice(6); // Remove 'media-' prefix
			const file = value as File;
			const r2Key = `${userId}/${filename}`;
			await platform!.env.MEDIA.put(r2Key, await file.arrayBuffer(), {
				httpMetadata: { contentType: file.type || 'application/octet-stream' }
			});
			mediaKeys.push(r2Key);
		}
	}

	return json({
		deckIds: Array.from(deckIdMap.values()),
		cardCount: cardStmts.length,
		mediaCount: mediaKeys.length
	});
};

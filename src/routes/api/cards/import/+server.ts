import { json, error } from '@sveltejs/kit';
import { getDb, newId } from '$lib/server/db';
import {
	IMPORT_LIMITS,
	assertMaxBytes,
	isSafeMediaFilename,
	mediaContentTypeForFilename,
	sanitizeCardHtml,
	sanitizePlainText
} from '$lib/sanitize';
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
	frontTemplate?: string;
	backTemplate?: string;
}

const BATCH_SIZE = 500;

function assertArrayLimit<T>(value: T[], max: number, label: string): void {
	if (value.length > max) {
		throw error(413, `${label} limit exceeded`);
	}
}

function sanitizeFields(fields: { name: string; value: string }[]): { name: string; value: string }[] {
	if (!Array.isArray(fields) || fields.length === 0) {
		throw error(400, 'Invalid note fields');
	}
	if (fields.length > IMPORT_LIMITS.maxFieldsPerNote) {
		throw error(413, 'Field limit exceeded');
	}

	return fields.map((field, index) => {
		const name = sanitizePlainText(field?.name ?? `Field ${index + 1}`, 1_000);
		const value = field?.value ?? '';
		assertMaxBytes(value, IMPORT_LIMITS.maxFieldBytes, 'Card field');
		return {
			name: name || `Field ${index + 1}`,
			value: sanitizeCardHtml(value)
		};
	});
}

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	if (!locals.userId) throw error(401, 'Unauthorized');

	const db = getDb(platform!);
	const userId = locals.userId;

	const formData = await request.formData();
	const dataStr = formData.get('data');
	if (!dataStr || typeof dataStr !== 'string') {
		throw error(400, 'Missing data field');
	}

	let parsed: { decks: ImportDeck[]; notes: ImportNote[]; cards: ImportCard[] };
	try {
		parsed = JSON.parse(dataStr) as typeof parsed;
	} catch {
		throw error(400, 'Invalid import data');
	}

	const { decks, notes, cards } = parsed;
	if (!Array.isArray(decks) || !Array.isArray(notes) || !Array.isArray(cards)) {
		throw error(400, 'Invalid import data');
	}
	assertArrayLimit(decks, IMPORT_LIMITS.maxDecks, 'Deck');
	assertArrayLimit(notes, IMPORT_LIMITS.maxNotes, 'Note');
	assertArrayLimit(cards, IMPORT_LIMITS.maxCards, 'Card');

	const mediaUploads: { filename: string; file: File }[] = [];
	let mediaCount = 0;
	let mediaBytes = 0;
	for (const [key, value] of formData.entries()) {
		if (!key.startsWith('media-')) continue;

		mediaCount++;
		if (mediaCount > IMPORT_LIMITS.maxMediaFiles) {
			throw error(413, 'Media file limit exceeded');
		}

		const filename = key.slice(6);
		if (!isSafeMediaFilename(filename)) {
			throw error(400, `Unsafe media filename: ${filename}`);
		}
		const contentType = mediaContentTypeForFilename(filename);
		if (!contentType) {
			throw error(400, `Unsupported media file type: ${filename}`);
		}
		if (!(value instanceof File)) {
			throw error(400, 'Invalid media file');
		}
		if (value.size > IMPORT_LIMITS.maxMediaFileBytes) {
			throw error(413, `Media file is too large: ${filename}`);
		}

		mediaBytes += value.size;
		if (mediaBytes > IMPORT_LIMITS.maxMediaTotalBytes) {
			throw error(413, 'Media upload is too large');
		}
		mediaUploads.push({ filename, file: value });
	}

	// Build ID mappings: Anki ID → UUID
	const deckIdMap = new Map<number, string>();
	const noteIdMap = new Map<number, string>();

	// Create decks
	const deckStmts: D1PreparedStatement[] = [];
	for (const deck of decks) {
		const id = newId();
		const name = sanitizePlainText(deck.name, 2_000) || 'Imported Deck';
		deckIdMap.set(deck.ankiId, id);
		deckStmts.push(
			db
				.prepare(
					'INSERT INTO decks (id, user_id, anki_id, name, card_count) VALUES (?, ?, ?, ?, 0)'
				)
				.bind(id, userId, deck.ankiId, name)
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
		if (!deckUuid) continue;
		const fields = sanitizeFields(note.fields);
		const modelName = sanitizePlainText(note.modelName, 2_000);
		const tags = sanitizePlainText(note.tags, IMPORT_LIMITS.maxTagsBytes);
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
					modelName,
					JSON.stringify(fields),
					tags
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
					'INSERT INTO cards (id, user_id, deck_id, note_id, anki_id, ordinal, card_type, front_template, back_template) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
				)
				.bind(
					id,
					userId,
					deckUuid,
					noteUuid,
					card.ankiId,
					Number.isFinite(card.ordinal) ? card.ordinal : 0,
					card.cardType === 'cloze' ? 'cloze' : 'basic',
					card.frontTemplate ? sanitizeCardHtml(card.frontTemplate) : null,
					card.backTemplate ? sanitizeCardHtml(card.backTemplate) : null
				)
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
	for (const { filename, file } of mediaUploads) {
		const r2Key = `${userId}/${filename}`;
		const contentType = mediaContentTypeForFilename(filename)!;
		await platform!.env.MEDIA.put(r2Key, await file.arrayBuffer(), {
			httpMetadata: { contentType }
		});
		mediaKeys.push(r2Key);
	}

	return json({
		deckIds: Array.from(deckIdMap.values()),
		cardCount: cardStmts.length,
		mediaCount: mediaKeys.length
	});
};

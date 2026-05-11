import { unzipSync } from 'fflate';
// @ts-expect-error sql.js has no type declarations
import initSqlJs from 'sql.js';
import {
	IMPORT_LIMITS,
	assertMaxBytes,
	isSafeMediaFilename,
	mediaContentTypeForFilename,
	sanitizeCardHtml,
	sanitizePlainText
} from '$lib/sanitize';

export interface ParsedDeck {
	ankiId: number;
	name: string;
}

export interface ParsedNote {
	ankiId: number;
	modelName: string;
	fields: { name: string; value: string }[];
	tags: string;
	deckId: number;
}

export interface ParsedCard {
	ankiId: number;
	noteAnkiId: number;
	deckAnkiId: number;
	ordinal: number;
	cardType: 'basic' | 'cloze';
	frontTemplate: string;
	backTemplate: string;
}

export interface ParsedApkg {
	decks: ParsedDeck[];
	notes: ParsedNote[];
	cards: ParsedCard[];
	media: Map<string, Blob>;
}

/**
 * Parse an .apkg file entirely client-side.
 * An .apkg is a ZIP containing:
 * - collection.anki2 or collection.anki21 (SQLite DB)
 * - media (JSON mapping: {"0": "image.jpg", "1": "audio.mp3"})
 * - numbered files (0, 1, 2...) which are the media blobs
 */
export async function parseApkg(file: File): Promise<ParsedApkg> {
	if (file.size > IMPORT_LIMITS.maxApkgBytes) {
		throw new Error('APKG file is too large');
	}

	const arrayBuffer = await file.arrayBuffer();
	const zip = unzipSync(new Uint8Array(arrayBuffer));
	const unzippedBytes = Object.values(zip).reduce((total, entry) => total + entry.byteLength, 0);
	if (unzippedBytes > IMPORT_LIMITS.maxUnzippedBytes) {
		throw new Error('APKG expands to too much data');
	}

	// Find the SQLite database file
	const dbFile =
		zip['collection.anki21'] ?? zip['collection.anki2'] ?? zip['collection'];
	if (!dbFile) {
		throw new Error('No collection database found in .apkg file');
	}

	// Initialize sql.js with WASM
	const SQL = await initSqlJs({
		locateFile: (filename: string) => `/${filename}`
	});
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const db: any = new SQL.Database(dbFile);

	// Extract deck info from col table
	const colRow = db.exec('SELECT decks, models FROM col')[0];
	if (!colRow || !colRow.values[0]) {
		throw new Error('Invalid Anki database: missing col table');
	}
	const decksJson = JSON.parse(colRow.values[0][0] as string) as Record<
		string,
		{ id: number; name: string }
	>;
	const modelsJson = JSON.parse(colRow.values[0][1] as string) as Record<
		string,
		{ id: number; name: string; flds: { name: string }[]; type: number }
	>;

	// Build model ID → model info map
	const modelMap = new Map<number, {
		name: string;
		fieldNames: string[];
		type: number;
		templates: { qfmt: string; afmt: string }[];
	}>();
	for (const [, model] of Object.entries(modelsJson)) {
		modelMap.set(model.id, {
			name: model.name,
			fieldNames: model.flds.map((f) => f.name),
			type: model.type,
			templates: ((model as unknown as { tmpls?: { qfmt?: string; afmt?: string }[] }).tmpls ?? []).map((t) => ({
				qfmt: sanitizeCardHtml(t.qfmt ?? ''),
				afmt: sanitizeCardHtml(t.afmt ?? '')
			}))
		});
	}

	// Parse decks (skip "Default" if empty)
	const decks: ParsedDeck[] = [];
	for (const [, deck] of Object.entries(decksJson)) {
		if (deck.name === 'Default' && deck.id === 1) continue;
		decks.push({ ankiId: deck.id, name: sanitizePlainText(deck.name, 2_000) });
	}

	// If we filtered everything, keep default
	if (decks.length === 0) {
		for (const [, deck] of Object.entries(decksJson)) {
			decks.push({ ankiId: deck.id, name: sanitizePlainText(deck.name, 2_000) });
		}
	}
	if (decks.length > IMPORT_LIMITS.maxDecks) {
		throw new Error('APKG contains too many decks');
	}

	// Parse notes
	const noteRows = db.exec('SELECT id, mid, flds, tags FROM notes')[0];
	const notes: ParsedNote[] = [];
	const noteModelMap = new Map<number, number>(); // note ID → model ID

	if (noteRows) {
		for (const row of noteRows.values) {
			const noteId = row[0] as number;
			const modelId = row[1] as number;
			const fieldsRaw = row[2] as string;
			const tags = sanitizePlainText(row[3], IMPORT_LIMITS.maxTagsBytes);

			noteModelMap.set(noteId, modelId);
			const model = modelMap.get(modelId);
			const fieldValues = fieldsRaw.split('\x1f');

			if (fieldValues.length > IMPORT_LIMITS.maxFieldsPerNote) {
				throw new Error('APKG contains notes with too many fields');
			}

			const fields = (model?.fieldNames ?? []).map((name, i) => {
				const value = fieldValues[i] ?? '';
				assertMaxBytes(value, IMPORT_LIMITS.maxFieldBytes, 'Card field');
				return {
					name: sanitizePlainText(name, 1_000),
					value: sanitizeCardHtml(value)
				};
			});

			// If model has more fields than names, add unnamed
			for (let i = model?.fieldNames.length ?? 0; i < fieldValues.length; i++) {
				const value = fieldValues[i];
				assertMaxBytes(value, IMPORT_LIMITS.maxFieldBytes, 'Card field');
				fields.push({ name: `Field ${i + 1}`, value: sanitizeCardHtml(value) });
			}

			notes.push({
				ankiId: noteId,
				modelName: model?.name ?? 'Unknown',
				fields,
				tags,
				deckId: 0 // Will be set from card data
			});
		}
	}
	if (notes.length > IMPORT_LIMITS.maxNotes) {
		throw new Error('APKG contains too many notes');
	}

	// Parse cards and link notes to decks
	const cardRows = db.exec('SELECT id, nid, did, ord, type FROM cards')[0];
	const cards: ParsedCard[] = [];
	const noteDeckMap = new Map<number, number>(); // note anki ID → deck anki ID

	if (cardRows) {
		for (const row of cardRows.values) {
			const cardId = row[0] as number;
			const noteAnkiId = row[1] as number;
			const deckAnkiId = row[2] as number;
			const ordinal = row[3] as number;
			const cardTypeRaw = row[4] as number;

			noteDeckMap.set(noteAnkiId, deckAnkiId);

			const modelId = noteModelMap.get(noteAnkiId);
			const model = modelId ? modelMap.get(modelId) : undefined;
			// model.type 1 = cloze note type; also detect cloze syntax in fields as fallback
			const note = notes.find((n) => n.ankiId === noteAnkiId);
			const hasClozeFields = note?.fields.some((f) => /\{\{c\d+::/.test(f.value)) ?? false;
			const isCloze = model?.type === 1 || hasClozeFields;
			const template = isCloze
				? model?.templates[0]
				: model?.templates[ordinal];

			cards.push({
				ankiId: cardId,
				noteAnkiId,
				deckAnkiId,
				ordinal,
				cardType: isCloze ? 'cloze' : 'basic',
				frontTemplate: template?.qfmt ?? '',
				backTemplate: template?.afmt ?? ''
			});
		}
	}
	if (cards.length > IMPORT_LIMITS.maxCards) {
		throw new Error('APKG contains too many cards');
	}

	// Set deck IDs on notes
	for (const note of notes) {
		note.deckId = noteDeckMap.get(note.ankiId) ?? decks[0]?.ankiId ?? 0;
	}

	// Extract media
	const media = new Map<string, Blob>();
	const mediaJsonFile = zip['media'];
	if (mediaJsonFile) {
		const mediaMap = JSON.parse(new TextDecoder().decode(mediaJsonFile)) as Record<
			string,
			string
		>;
		let mediaCount = 0;
		let mediaBytes = 0;
		for (const [numKey, filename] of Object.entries(mediaMap)) {
			mediaCount++;
			if (mediaCount > IMPORT_LIMITS.maxMediaFiles) {
				throw new Error('APKG contains too many media files');
			}
			if (!isSafeMediaFilename(filename)) {
				throw new Error(`Unsafe media filename: ${filename}`);
			}
			if (!mediaContentTypeForFilename(filename)) {
				throw new Error(`Unsupported media file type: ${filename}`);
			}
			const fileData = zip[numKey];
			if (fileData) {
				if (fileData.byteLength > IMPORT_LIMITS.maxMediaFileBytes) {
					throw new Error(`Media file is too large: ${filename}`);
				}
				mediaBytes += fileData.byteLength;
				if (mediaBytes > IMPORT_LIMITS.maxMediaTotalBytes) {
					throw new Error('APKG media is too large');
				}
				const mediaArrayBuffer = fileData.buffer.slice(
					fileData.byteOffset,
					fileData.byteOffset + fileData.byteLength
				) as ArrayBuffer;
				media.set(filename, new Blob([mediaArrayBuffer]));
			}
		}
	}

	db.close();

	return { decks, notes, cards, media };
}

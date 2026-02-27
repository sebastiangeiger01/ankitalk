import { unzipSync } from 'fflate';
// @ts-expect-error sql.js has no type declarations
import initSqlJs from 'sql.js';

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
	const arrayBuffer = await file.arrayBuffer();
	const zip = unzipSync(new Uint8Array(arrayBuffer));

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
	const modelMap = new Map<number, { name: string; fieldNames: string[]; type: number }>();
	for (const [, model] of Object.entries(modelsJson)) {
		modelMap.set(model.id, {
			name: model.name,
			fieldNames: model.flds.map((f) => f.name),
			type: model.type
		});
	}

	// Parse decks (skip "Default" if empty)
	const decks: ParsedDeck[] = [];
	for (const [, deck] of Object.entries(decksJson)) {
		if (deck.name === 'Default' && deck.id === 1) continue;
		decks.push({ ankiId: deck.id, name: deck.name });
	}

	// If we filtered everything, keep default
	if (decks.length === 0) {
		for (const [, deck] of Object.entries(decksJson)) {
			decks.push({ ankiId: deck.id, name: deck.name });
		}
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
			const tags = (row[3] as string).trim();

			noteModelMap.set(noteId, modelId);
			const model = modelMap.get(modelId);
			const fieldValues = fieldsRaw.split('\x1f');

			const fields = (model?.fieldNames ?? []).map((name, i) => ({
				name,
				value: fieldValues[i] ?? ''
			}));

			// If model has more fields than names, add unnamed
			for (let i = model?.fieldNames.length ?? 0; i < fieldValues.length; i++) {
				fields.push({ name: `Field ${i + 1}`, value: fieldValues[i] });
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

			cards.push({
				ankiId: cardId,
				noteAnkiId,
				deckAnkiId,
				ordinal,
				cardType: isCloze ? 'cloze' : 'basic'
			});
		}
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
		for (const [numKey, filename] of Object.entries(mediaMap)) {
			const fileData = zip[numKey];
			if (fileData) {
				media.set(filename, new Blob([fileData.buffer as ArrayBuffer]));
			}
		}
	}

	db.close();

	return { decks, notes, cards, media };
}

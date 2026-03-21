// @ts-expect-error sql.js has no type declarations
import initSqlJs from 'sql.js';
import { zipSync } from 'fflate';

interface ExportDeck {
	id: string;
	anki_id: number | null;
	name: string;
}

interface ExportNote {
	id: string;
	anki_id: number | null;
	model_name: string;
	fields: string; // JSON array of {name, value}
	tags: string;
}

interface ExportCard {
	id: string;
	anki_id: number | null;
	note_id: string;
	ordinal: number;
	card_type: string;
	due_at: string;
	fsrs_state: number;
	fsrs_reps: number;
	fsrs_lapses: number;
	fsrs_scheduled_days: number;
	suspended: number;
	learning_step_index: number;
}

/** Extract unique media filenames from note field HTML (img src, audio src, [sound:...]) */
export function extractMediaFilenames(notes: ExportNote[]): Set<string> {
	const filenames = new Set<string>();
	const srcPattern = /(?:<(?:img|audio|source)\b[^>]*\bsrc\s*=\s*["'])(?!https?:\/\/|data:)([^"']+)["']/gi;
	const soundPattern = /\[sound:([^\]]+)\]/gi;

	for (const note of notes) {
		let fields: { name: string; value: string }[];
		try {
			fields = JSON.parse(note.fields);
		} catch {
			continue;
		}
		for (const field of fields) {
			let match;
			while ((match = srcPattern.exec(field.value)) !== null) {
				filenames.add(match[1]);
			}
			while ((match = soundPattern.exec(field.value)) !== null) {
				filenames.add(match[1]);
			}
		}
	}
	return filenames;
}

/** Generate a timestamp-based Anki ID (milliseconds since epoch). */
function ankiTs(): number {
	return Math.floor(Date.now() / 1000);
}

/** Map FSRS state to Anki type: 0=new, 1=learning, 2=review, 3=relearning */
function fsrsToAnkiType(state: number): number {
	if (state === 0) return 0; // new
	if (state === 1) return 1; // learning
	if (state === 2) return 2; // review
	if (state === 3) return 3; // relearning
	return 0;
}

/** Map FSRS state to Anki queue: 0=new, 1=learning, 2=due, 3=suspended/buried */
function fsrsToAnkiQueue(state: number): number {
	if (state === 0) return 0;
	if (state === 1 || state === 3) return 1;
	if (state === 2) return 2;
	return 0;
}

export async function buildApkg(
	deck: ExportDeck,
	notes: ExportNote[],
	cards: ExportCard[],
	media?: Map<string, Uint8Array>
): Promise<Uint8Array> {
	const SQL = await initSqlJs({
		locateFile: (filename: string) => `/${filename}`
	});

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const db: any = new SQL.Database();

	// sql.js browser build has a bug: Database.run(sql, params) calls
	// Database.prepare(sql, params), but the browser build's prepare()
	// only accepts one argument and silently drops the params array.
	// All ? placeholders become NULL, causing NOT NULL constraint errors.
	// Workaround: use prepare() + bind() + step() + free() explicitly.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	function runWithParams(sql: string, params: any[]) {
		const stmt = db.prepare(sql);
		stmt.bind(params);
		stmt.step();
		stmt.free();
	}

	const deckAnkiId = deck.anki_id ?? ankiTs();
	const modelId = ankiTs() + 1;

	// Determine field names from first note
	let fieldNames: string[] = ['Front', 'Back'];
	if (notes.length > 0) {
		try {
			const fields = JSON.parse(notes[0].fields) as { name: string; value: string }[];
			fieldNames = fields.map((f) => f.name);
		} catch {
			// use defaults
		}
	}

	// Build Anki col JSON structures
	const decksJson: Record<string, object> = {
		'1': { id: 1, name: 'Default', mod: 0, usn: 0, collapsed: false, desc: '', conf: 1 },
		[String(deckAnkiId)]: {
			id: deckAnkiId,
			name: deck.name,
			mod: ankiTs(),
			usn: -1,
			collapsed: false,
			desc: '',
			conf: 1
		}
	};

	const modelsJson: Record<string, object> = {
		[String(modelId)]: {
			id: modelId,
			name: notes[0]?.model_name ?? 'Basic',
			mod: ankiTs(),
			type: 0,
			flds: fieldNames.map((name, i) => ({
				name,
				ord: i,
				sticky: false,
				rtl: false,
				font: 'Arial',
				size: 20
			})),
			tmpls: [
				{
					name: 'Card 1',
					ord: 0,
					qfmt: '{{' + (fieldNames[0] ?? 'Front') + '}}',
					afmt: '{{FrontSide}}<hr id="answer">{{' + (fieldNames[1] ?? 'Back') + '}}',
					did: null
				}
			],
			css: '.card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }',
			usn: -1,
			sortf: 0,
			req: [[0, 'all', [0]]]
		}
	};

	// Create Anki schema
	db.run(`CREATE TABLE col (
		id integer primary key, crt integer not null, mod integer not null,
		scm integer not null, ver integer not null, dty integer not null,
		usn integer not null, ls integer not null, conf text not null,
		models text not null, decks text not null, dconf text not null, tags text not null
	)`);

	db.run(`CREATE TABLE notes (
		id integer primary key, guid text not null, mid integer not null,
		mod integer not null, usn integer not null, tags text not null,
		flds text not null, sfld text not null, csum integer not null,
		flags integer not null, data text not null
	)`);

	db.run(`CREATE TABLE cards (
		id integer primary key, nid integer not null, did integer not null,
		ord integer not null, mod integer not null, usn integer not null,
		type integer not null, queue integer not null, due integer not null,
		ivl integer not null, factor integer not null, reps integer not null,
		lapses integer not null, left integer not null, odue integer not null,
		odid integer not null, flags integer not null, data text not null
	)`);

	db.run(`CREATE TABLE revlog (
		id integer primary key, cid integer not null, usn integer not null,
		ease integer not null, ivl integer not null, lastIvl integer not null,
		factor integer not null, time integer not null, type integer not null
	)`);

	db.run(`CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null)`);

	// Indexes expected by Anki Desktop on import
	db.run('CREATE INDEX ix_notes_usn ON notes (usn)');
	db.run('CREATE INDEX ix_notes_csum ON notes (csum)');
	db.run('CREATE INDEX ix_cards_usn ON cards (usn)');
	db.run('CREATE INDEX ix_cards_nid ON cards (nid)');
	db.run('CREATE INDEX ix_cards_sched ON cards (did, queue, due)');
	db.run('CREATE INDEX ix_revlog_usn ON revlog (usn)');
	db.run('CREATE INDEX ix_revlog_cid ON revlog (cid)');

	const now = ankiTs();
	const dconf = JSON.stringify({
		'1': {
			id: 1, name: 'Default', maxTaken: 60, autoplay: true, timer: 0,
			new: { delays: [1, 10], ints: [1, 4, 0], initialFactor: 2500, order: 1, perDay: 20 },
			rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, minSpace: 1, ivlFct: 1, maxIvl: 36500 },
			lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 }
		}
	});

	runWithParams(
		'INSERT INTO col VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
		[1, now, now, now * 1000, 11, 0, 0, 0, '{}', JSON.stringify(modelsJson), JSON.stringify(decksJson), dconf, '{}']
	);

	// Build note ID map (our ID → Anki ID)
	const noteIdMap = new Map<string, number>();
	let noteSeq = now * 1000;

	for (const note of notes) {
		const noteAnkiId = note.anki_id ?? ++noteSeq;
		noteIdMap.set(note.id, noteAnkiId);

		let fields: { name: string; value: string }[];
		try {
			fields = JSON.parse(note.fields);
		} catch {
			fields = [];
		}

		const flds = fields.map((f) => f.value).join('\x1f');
		const sfld = fields[0]?.value ?? '';

		// Simple checksum (Anki uses first field CRC32, we approximate)
		let csum = 0;
		for (let i = 0; i < sfld.length; i++) {
			csum = (csum * 31 + sfld.charCodeAt(i)) | 0;
		}
		csum = Math.abs(csum);

		runWithParams(
			'INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[noteAnkiId, String(noteAnkiId), modelId, now, -1, note.tags, flds, sfld, csum, 0, '']
		);
	}

	// Insert cards
	let cardSeq = now * 1000 + 500000;

	for (const card of cards) {
		const cardAnkiId = card.anki_id ?? ++cardSeq;
		const noteAnkiId = noteIdMap.get(card.note_id) ?? 0;
		if (!noteAnkiId) continue;

		const type = fsrsToAnkiType(card.fsrs_state);
		const queue = card.suspended ? -1 : fsrsToAnkiQueue(card.fsrs_state);
		const dueMs = card.due_at ? new Date(card.due_at).getTime() : 0;
		const due = card.fsrs_state === 0 ? 0 : (Number.isFinite(dueMs) ? Math.floor(dueMs / 86400000) : 0);
		const ivl = card.fsrs_scheduled_days ?? 0;
		const left = card.learning_step_index ?? 0;

		runWithParams(
			'INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[cardAnkiId, noteAnkiId, deckAnkiId, card.ordinal, now, -1, type, queue, due, ivl, 2500, card.fsrs_reps, card.fsrs_lapses, left, 0, 0, 0, '']
		);
	}

	// Export SQLite as binary
	const dbData = db.export() as Uint8Array;
	db.close();

	// Build media manifest and numbered file entries
	const zipEntries: Record<string, Uint8Array> = {
		'collection.anki21': dbData
	};

	const mediaManifest: Record<string, string> = {};
	if (media && media.size > 0) {
		let idx = 0;
		for (const [filename, data] of media) {
			mediaManifest[String(idx)] = filename;
			zipEntries[String(idx)] = data;
			idx++;
		}
	}

	zipEntries['media'] = new TextEncoder().encode(JSON.stringify(mediaManifest));

	const zipped = zipSync(zipEntries);
	return zipped;
}

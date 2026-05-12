import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { zipSync } from 'fflate';

const outDir = path.resolve('test-decks');
fs.mkdirSync(outDir, { recursive: true });
for (const file of fs.readdirSync(outDir)) {
	if (file.endsWith('.apkg')) fs.rmSync(path.join(outDir, file));
}

const SQL = await initSqlJs({
	locateFile: (filename) => path.resolve('node_modules/sql.js/dist', filename)
});

const encoder = new TextEncoder();

function nowSeconds() {
	return Math.floor(Date.now() / 1000);
}

function run(db, sql, params = []) {
	const stmt = db.prepare(sql);
	stmt.bind(params);
	stmt.step();
	stmt.free();
}

function makeSchema(db) {
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
	db.run('CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null)');
	db.run('CREATE INDEX ix_notes_usn ON notes (usn)');
	db.run('CREATE INDEX ix_notes_csum ON notes (csum)');
	db.run('CREATE INDEX ix_cards_usn ON cards (usn)');
	db.run('CREATE INDEX ix_cards_nid ON cards (nid)');
	db.run('CREATE INDEX ix_cards_sched ON cards (did, queue, due)');
	db.run('CREATE INDEX ix_revlog_usn ON revlog (usn)');
	db.run('CREATE INDEX ix_revlog_cid ON revlog (cid)');
}

function csum(value) {
	let checksum = 0;
	for (let i = 0; i < value.length; i++) {
		checksum = (checksum * 31 + value.charCodeAt(i)) | 0;
	}
	return Math.abs(checksum);
}

function makeDeck({ deckId, deckName, models, notes, cards, media = {} }) {
	const db = new SQL.Database();
	makeSchema(db);

	const now = nowSeconds();
	const decksJson = {
		'1': { id: 1, name: 'Default', mod: 0, usn: 0, collapsed: false, desc: '', conf: 1 },
		[String(deckId)]: {
			id: deckId,
			name: deckName,
			mod: now,
			usn: -1,
			collapsed: false,
			desc: '',
			conf: 1
		}
	};
	const modelsJson = Object.fromEntries(models.map((model) => [String(model.id), model]));
	const dconf = JSON.stringify({
		'1': {
			id: 1,
			name: 'Default',
			maxTaken: 60,
			autoplay: true,
			timer: 0,
			new: { delays: [1, 10], ints: [1, 4, 0], initialFactor: 2500, order: 1, perDay: 20 },
			rev: { perDay: 200, ease4: 1.3, fuzz: 0.05, minSpace: 1, ivlFct: 1, maxIvl: 36500 },
			lapse: { delays: [10], mult: 0, minInt: 1, leechFails: 8, leechAction: 0 }
		}
	});

	run(db, 'INSERT INTO col VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
		1,
		now,
		now,
		now * 1000,
		11,
		0,
		0,
		0,
		'{}',
		JSON.stringify(modelsJson),
		JSON.stringify(decksJson),
		dconf,
		'{}'
	]);

	for (const note of notes) {
		const firstField = note.fields[0] ?? '';
		run(db, 'INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
			note.id,
			`guid-${note.id}`,
			note.modelId,
			now,
			-1,
			note.tags ?? '',
			note.fields.join('\x1f'),
			firstField,
			csum(firstField),
			0,
			''
		]);
	}

	for (const card of cards) {
		run(db, 'INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
			card.id,
			card.noteId,
			deckId,
			card.ord,
			now,
			-1,
			0,
			0,
			0,
			0,
			2500,
			0,
			0,
			0,
			0,
			0,
			0,
			''
		]);
	}

	const dbData = db.export();
	db.close();

	const mediaEntries = Object.entries(media);
	const mediaManifest = Object.fromEntries(mediaEntries.map(([filename], index) => [String(index), filename]));
	const zipEntries = {
		'collection.anki21': dbData,
		media: encoder.encode(JSON.stringify(mediaManifest))
	};
	for (const [index, [, bytes]] of mediaEntries.entries()) {
		zipEntries[String(index)] = bytes;
	}

	return zipSync(zipEntries);
}

function basicModel(id) {
	return {
		id,
		name: 'AnkiTalk Test Basic',
		mod: nowSeconds(),
		type: 0,
		flds: ['Front', 'Back', 'Extra'].map((name, ord) => ({
			name,
			ord,
			sticky: false,
			rtl: false,
			font: 'Arial',
			size: 20
		})),
		tmpls: [
			{
				name: 'Card 1',
				ord: 0,
				qfmt: '<section class="front">{{Front}}{{#Extra}}<p class="extra">{{Extra}}</p>{{/Extra}}</section>',
				afmt: '{{FrontSide}}<hr id="answer"><section class="back">{{Back}}</section>',
				did: null
			}
		],
		css: '.card { font-family: arial; font-size: 20px; text-align: center; color: black; background: white; }',
		usn: -1,
		sortf: 0,
		req: [[0, 'all', [0]]]
	};
}

function clozeModel(id) {
	return {
		id,
		name: 'AnkiTalk Test Cloze',
		mod: nowSeconds(),
		type: 1,
		flds: ['Text', 'Extra'].map((name, ord) => ({
			name,
			ord,
			sticky: false,
			rtl: false,
			font: 'Arial',
			size: 20
		})),
		tmpls: [
			{
				name: 'Cloze',
				ord: 0,
				qfmt: '{{cloze:Text}}{{#Extra}}<p class="extra">{{Extra}}</p>{{/Extra}}',
				afmt: '{{cloze:Text}}<hr id="answer">{{Extra}}',
				did: null
			}
		],
		css: '.card { font-family: arial; font-size: 20px; text-align: center; color: black; background: white; } .cloze { font-weight: bold; color: blue; }',
		usn: -1,
		sortf: 0,
		req: [[0, 'all', [0]]]
	};
}

const tinyPng = Uint8Array.from(Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
	'base64'
));

function toneWav() {
	const sampleRate = 8000;
	const seconds = 0.2;
	const samples = Math.floor(sampleRate * seconds);
	const dataSize = samples * 2;
	const buffer = Buffer.alloc(44 + dataSize);
	buffer.write('RIFF', 0);
	buffer.writeUInt32LE(36 + dataSize, 4);
	buffer.write('WAVE', 8);
	buffer.write('fmt ', 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * 2, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write('data', 36);
	buffer.writeUInt32LE(dataSize, 40);
	for (let i = 0; i < samples; i++) {
		const sample = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.2;
		buffer.writeInt16LE(Math.floor(sample * 32767), 44 + i * 2);
	}
	return Uint8Array.from(buffer);
}

const friendlySvg = encoder.encode(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">
	<defs>
		<linearGradient id="good-gradient" x1="0" x2="1">
			<stop offset="0" stop-color="#0f766e"/>
			<stop offset="1" stop-color="#f59e0b"/>
		</linearGradient>
	</defs>
	<rect width="120" height="60" rx="8" fill="url(#good-gradient)"/>
	<text x="60" y="36" text-anchor="middle" font-size="18" fill="white">SVG OK</text>
</svg>
`);

const hostileSvg = encoder.encode(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60" onload="alert('svg')">
	<script>alert('xss')</script>
	<foreignObject width="120" height="60"><body onload="alert('html')">bad</body></foreignObject>
	<defs>
		<linearGradient id="kept-gradient" x1="0" x2="1">
			<stop offset="0" stop-color="#2563eb"/>
			<stop offset="1" stop-color="#22c55e"/>
		</linearGradient>
	</defs>
	<image href="https://tracker.invalid/pixel.png" width="1" height="1"/>
	<rect width="120" height="60" rx="8" fill="url(#kept-gradient)" style="stroke: #111; background-image: url(https://tracker.invalid/x)"/>
	<set attributeName="href" to="https://tracker.invalid/late.png"/>
	<a href="javascript:alert('link')"><text x="60" y="36" text-anchor="middle" font-size="14" fill="white">Sanitized SVG</text></a>
</svg>
`);

function writeDeck(filename, bytes) {
	fs.writeFileSync(path.join(outDir, filename), bytes);
	console.log(`${filename} (${bytes.byteLength} bytes)`);
}

const basicId = 1700000001000;
const clozeId = 1700000002000;
const deckId = 1700000003000;

writeDeck(
	'ankitalk-good-mixed.apkg',
	makeDeck({
		deckId,
		deckName: 'AnkiTalk Good Mixed Test',
		models: [basicModel(basicId), clozeModel(clozeId)],
		notes: [
			{
				id: 1700000100001,
				modelId: basicId,
				tags: ' good basic ',
				fields: [
					'What is the capital of France?',
					'Paris',
					'Plain basic card.'
				]
			},
			{
				id: 1700000100002,
				modelId: basicId,
				tags: ' good media ',
				fields: [
					'Media front:<br><img src="tiny.png" alt="tiny test image"><br><img src="my image (final) ü.png" alt="friendly filename image"><br><img src="friendly diagram.svg" alt="friendly SVG">',
					`Media back:<br><audio controls src="tone.wav"></audio><br><audio controls src="O'Brien tone.wav"></audio>`,
					'Image, SVG, audio, spaces, Unicode, and apostrophes in filenames should survive import.'
				]
			},
			{
				id: 1700000100003,
				modelId: clozeId,
				tags: ' good cloze ',
				fields: [
					'{{c1::Alpha}} should blank on card one; {{c2::Beta::B hint}} should blank on card two.',
					'Checks cloze ordinals and hints.'
				]
			}
		],
		cards: [
			{ id: 1700000200001, noteId: 1700000100001, ord: 0 },
			{ id: 1700000200002, noteId: 1700000100002, ord: 0 },
			{ id: 1700000200003, noteId: 1700000100003, ord: 0 },
			{ id: 1700000200004, noteId: 1700000100003, ord: 1 }
		],
		media: {
			'tiny.png': tinyPng,
			'my image (final) ü.png': tinyPng,
			'tone.wav': toneWav(),
			"O'Brien tone.wav": toneWav(),
			'friendly diagram.svg': friendlySvg
		}
	})
);

writeDeck(
	'ankitalk-hostile-html-should-import-sanitized.apkg',
	makeDeck({
		deckId: deckId + 1,
		deckName: 'AnkiTalk Hostile HTML Should Import Sanitized',
		models: [basicModel(basicId + 1)],
		notes: [
			{
				id: 1700000110001,
				modelId: basicId + 1,
				tags: ' hostile sanitized ',
				fields: [
					'<p onclick="alert(1)">Unsafe click handler should vanish.</p><script>alert("xss")</script><a href="javascript:alert(1)">Unsafe link should lose href</a><span style="position:absolute;color:#123;font-weight:bold">Only safe styles remain</span>',
					'<img src="../secret.png"><img src="safe.png"><audio src="javascript:alert(1)" controls></audio>',
					'This deck should import, but dangerous HTML/URLs should be neutralized.'
				]
			}
		],
		cards: [{ id: 1700000210001, noteId: 1700000110001, ord: 0 }],
		media: {
			'safe.png': tinyPng
		}
	})
);

writeDeck(
	'ankitalk-reject-path-traversal-media.apkg',
	makeDeck({
		deckId: deckId + 2,
		deckName: 'AnkiTalk Reject Path Traversal Media',
		models: [basicModel(basicId + 2)],
		notes: [
			{
				id: 1700000120001,
				modelId: basicId + 2,
				tags: ' reject unsafe-media ',
				fields: ['This deck should be rejected before upload.', 'The media manifest contains ../evil.png.', '']
			}
		],
		cards: [{ id: 1700000220001, noteId: 1700000120001, ord: 0 }],
		media: {
			'../evil.png': tinyPng
		}
	})
);

writeDeck(
	'ankitalk-svg-should-import-sanitized.apkg',
	makeDeck({
		deckId: deckId + 3,
		deckName: 'AnkiTalk SVG Should Import Sanitized',
		models: [basicModel(basicId + 3)],
		notes: [
			{
				id: 1700000130001,
				modelId: basicId + 3,
				tags: ' svg sanitized ',
				fields: [
					'This deck should import, but the SVG should be sanitized before storage.',
					'<img src="payload.svg">',
					'The source SVG contains script/event/external URL payloads.'
				]
			}
		],
		cards: [{ id: 1700000230001, noteId: 1700000130001, ord: 0 }],
		media: {
			'payload.svg': hostileSvg
		}
	})
);

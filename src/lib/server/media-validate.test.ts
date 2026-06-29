// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { validateNoteMedia, validateDeckMedia } from './media-validate';

/** Minimal D1 fake: prepare(sql) → bind(...) → first()/all() resolving from a sql-keyed responder. */
function fakeDb(responder: (sql: string, binds: unknown[]) => unknown) {
	return {
		prepare(sql: string) {
			let binds: unknown[] = [];
			const api = {
				bind: (...args: unknown[]) => {
					binds = args;
					return api;
				},
				first: () => Promise.resolve(responder(sql, binds)),
				all: () => Promise.resolve({ results: responder(sql, binds) ?? [] })
			};
			return api;
		}
	} as unknown as D1Database;
}

/** R2 fake whose head() returns an object only for keys in `present`. */
function fakeBucket(present: Set<string>) {
	return {
		head: (key: string) => Promise.resolve(present.has(key) ? ({ key } as R2Object) : null)
	} as unknown as R2Bucket;
}

describe('validateNoteMedia', () => {
	it('reports missing image references', async () => {
		const db = fakeDb((sql) => {
			if (sql.includes('FROM notes')) {
				return { fields: JSON.stringify([{ name: 'Front', value: '<img src="here.png"><img src="gone.png">' }]) };
			}
			return null;
		});
		const bucket = fakeBucket(new Set(['user-1/here.png']));

		const result = await validateNoteMedia(db, bucket, 'user-1', 'note-1');
		expect(result).toEqual({ note_id: 'note-1', total_refs: 2, missing: ['gone.png'], ok: false });
	});

	it('throws NOTE_NOT_FOUND when the note is missing', async () => {
		const db = fakeDb(() => null);
		await expect(validateNoteMedia(db, fakeBucket(new Set()), 'user-1', 'nope')).rejects.toThrow('NOTE_NOT_FOUND');
	});
});

describe('validateDeckMedia', () => {
	it('aggregates missing refs across notes', async () => {
		const db = fakeDb((sql) => {
			if (sql.includes('FROM decks')) return { id: 'deck-1' };
			if (sql.includes('FROM notes')) {
				return [
					{ id: 'n1', fields: JSON.stringify([{ name: 'F', value: '<img src="ok.png">' }]) },
					{ id: 'n2', fields: JSON.stringify([{ name: 'F', value: '<img src="missing.svg">' }]) }
				];
			}
			return null;
		});
		const bucket = fakeBucket(new Set(['user-1/ok.png']));

		const result = await validateDeckMedia(db, bucket, 'user-1', 'deck-1');
		expect(result.notes_checked).toBe(2);
		expect(result.total_refs).toBe(2);
		expect(result.ok).toBe(false);
		expect(result.missing).toEqual([{ note_id: 'n2', filename: 'missing.svg' }]);
	});
});

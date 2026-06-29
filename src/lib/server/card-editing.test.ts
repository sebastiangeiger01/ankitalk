// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyTagChanges, mergeFieldPatches, parseTags, reconcileOrdinals, reorderedDueAts, serializeTags } from './card-editing';

describe('mergeFieldPatches', () => {
	const base = [
		{ name: 'Front', value: 'q' },
		{ name: 'Back', value: 'a' }
	];

	it('replaces a named field and leaves the others untouched', () => {
		expect(mergeFieldPatches(base, [{ name: 'Back', value: 'a2' }])).toEqual([
			{ name: 'Front', value: 'q' },
			{ name: 'Back', value: 'a2' }
		]);
	});

	it('appends a field whose name does not exist yet', () => {
		expect(mergeFieldPatches(base, [{ name: 'Extra', value: 'x' }])).toEqual([
			{ name: 'Front', value: 'q' },
			{ name: 'Back', value: 'a' },
			{ name: 'Extra', value: 'x' }
		]);
	});

	it('does not mutate the input fields', () => {
		mergeFieldPatches(base, [{ name: 'Front', value: 'changed' }]);
		expect(base[0].value).toBe('q');
	});
});

describe('parseTags / serializeTags', () => {
	it('splits on whitespace and drops empties', () => {
		expect(parseTags('  bio   exam\tcells ')).toEqual(['bio', 'exam', 'cells']);
		expect(parseTags('')).toEqual([]);
	});

	it('de-duplicates while preserving order', () => {
		expect(serializeTags(['bio', 'exam', 'bio', 'cells'])).toBe('bio exam cells');
	});
});

describe('applyTagChanges', () => {
	it('adds and removes against the current tags', () => {
		expect(applyTagChanges('bio exam', { add: ['cells'], remove: ['exam'] })).toBe('bio cells');
	});

	it('replaces the whole list with set, then layers add/remove', () => {
		expect(applyTagChanges('old tags here', { set: ['fresh'], add: ['more'] })).toBe('fresh more');
	});

	it('is a no-op-safe when adding an existing tag', () => {
		expect(applyTagChanges('bio', { add: ['bio'] })).toBe('bio');
	});

	it('removing a missing tag leaves the list unchanged', () => {
		expect(applyTagChanges('bio exam', { remove: ['nope'] })).toBe('bio exam');
	});
});

describe('reconcileOrdinals', () => {
	it('finds added and removed ordinals for a cloze edit', () => {
		expect(reconcileOrdinals([0, 1], [0, 2])).toEqual({ toAdd: [2], toRemove: [1] });
	});

	it('reports nothing to do when the ordinal set is unchanged', () => {
		expect(reconcileOrdinals([0, 1, 2], [2, 1, 0])).toEqual({ toAdd: [], toRemove: [] });
	});

	it('handles a basic note staying a single card', () => {
		expect(reconcileOrdinals([0], [0])).toEqual({ toAdd: [], toRemove: [] });
	});
});

describe('reorderedDueAts', () => {
	it('produces strictly increasing timestamps 1s apart from the base', () => {
		const due = reorderedDueAts('2026-01-01T00:00:00.000Z', 3);
		expect(due).toEqual([
			'2026-01-01T00:00:00.000Z',
			'2026-01-01T00:00:01.000Z',
			'2026-01-01T00:00:02.000Z'
		]);
		expect(Date.parse(due[0])).toBeLessThan(Date.parse(due[1]));
		expect(Date.parse(due[1])).toBeLessThan(Date.parse(due[2]));
	});

	it('falls back to now for an unparseable base without throwing', () => {
		const due = reorderedDueAts('not-a-date', 2);
		expect(due).toHaveLength(2);
		expect(Date.parse(due[0])).toBeLessThan(Date.parse(due[1]));
	});
});

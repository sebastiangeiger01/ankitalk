// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildFtsQuery, renderStudyCard } from './study-context';

describe('buildFtsQuery', () => {
	it('normalizes natural language into a bounded prefix query', () => {
		expect(buildFtsQuery('  Bayesian inference!  ')).toBe('"Bayesian"* AND "inference"*');
	});

	it('rejects punctuation-only input', () => {
		expect(buildFtsQuery(' -- !! ')).toBeNull();
	});

	it('supports German and accented Unicode terms', () => {
		expect(buildFtsQuery('größere Übertragung')).toBe('"größere"* AND "Übertragung"*');
	});
});

describe('renderStudyCard', () => {
	it('renders the active cloze ordinal without a browser DOM', () => {
		const card = renderStudyCard({
			card_id: 'c2',
			note_id: 'n1',
			deck_id: 'd1',
			deck_name: 'Biology',
			card_type: 'cloze',
			ordinal: 1,
			front_template: null,
			back_template: null,
			fields: JSON.stringify([{ name: 'Text', value: '{{c1::Mitosis}} and {{c2::meiosis::division}}' }]),
			tags: 'cells exam',
			fsrs_state: 2,
			due_at: '2026-06-22T00:00:00Z',
			fsrs_reps: 4,
			fsrs_lapses: 1,
			fsrs_stability: 3.5,
			fsrs_difficulty: 5.2,
			suspended: 0
		});
		expect(card.question).toContain('Mitosis and division');
		expect(card.answer).toContain('Mitosis and meiosis');
		expect(card.tags).toEqual(['cells', 'exam']);
	});

	it('returns raw field values whole (no 2k clip) so read→patch round-trips losslessly', () => {
		// A realistic Back with several images + captions easily exceeds 2000 chars of HTML.
		const longBack =
			'<img src="a.png"><p>caption</p>'.repeat(120) + '<p>Merksatz / Selbstcheck / Prüfungsanker</p>';
		expect(longBack.length).toBeGreaterThan(2_000);
		const card = renderStudyCard({
			card_id: 'c1',
			note_id: 'n1',
			deck_id: 'd1',
			deck_name: 'Vortrag',
			card_type: 'basic',
			ordinal: 0,
			front_template: null,
			back_template: null,
			fields: JSON.stringify([
				{ name: 'Front', value: 'Frage?' },
				{ name: 'Back', value: longBack }
			]),
			tags: '',
			fsrs_state: 0,
			due_at: '2026-06-22T00:00:00Z',
			fsrs_reps: 0,
			fsrs_lapses: 0,
			fsrs_stability: 0,
			fsrs_difficulty: 0,
			suspended: 0
		});
		const back = card.fields.find((f) => f.name === 'Back');
		expect(back?.value).toBe(longBack); // full value, not clipped at 2000
	});
});

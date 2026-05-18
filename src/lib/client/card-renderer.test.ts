import { describe, expect, it } from 'vitest';
import { renderCard } from './card-renderer';
import type { NoteField } from '../types';

function fieldsJson(fields: NoteField[]): string {
	return JSON.stringify(fields);
}

describe('renderCard', () => {
	it('renders only the active cloze ordinal as blank on the front', () => {
		const fields = fieldsJson([
			{ name: 'Text', value: '{{c1::alpha}} {{c2::beta::B hint}}' }
		]);

		const first = renderCard(fields, 'cloze', 0);
		const second = renderCard(fields, 'cloze', 1);

		expect(first.front).toBe('blank beta');
		expect(first.back).toBe('alpha beta');
		expect(first.frontHtml).toContain('cloze-blank');
		expect(first.frontHtml).toContain('beta');

		expect(second.front).toBe('alpha B hint');
		expect(second.back).toBe('alpha beta');
		expect(second.frontHtml).toContain('[B hint]');
		expect(second.frontHtml).not.toContain('{{c');
	});

	it('renders Anki field templates, conditionals, FrontSide, and text filters', () => {
		const fields = fieldsJson([
			{ name: 'Front', value: '<b>Capital</b>' },
			{ name: 'Back', value: 'Paris' },
			{ name: 'Extra', value: '' }
		]);

		const result = renderCard(
			fields,
			'basic',
			0,
			'{{Front}}{{#Back}}<hr>{{Back}}{{/Back}}{{^Extra}}<em>No extra</em>{{/Extra}}',
			'{{FrontSide}}<section>{{text:Front}} / {{Back}}</section><script>alert(1)</script>'
		);

		expect(result.frontHtml).toContain('<b>Capital</b>');
		expect(result.frontHtml).toContain('Paris');
		expect(result.frontHtml).toContain('<em>No extra</em>');
		expect(result.back).toContain('Capital / Paris');
		expect(result.backHtml).not.toContain('script');
	});

	it('uses cloze templates with the card ordinal from Anki', () => {
		const fields = fieldsJson([
			{ name: 'Text', value: '{{c1::alpha}} {{c2::beta}}' }
		]);

		const result = renderCard(
			fields,
			'cloze',
			1,
			'{{cloze:Text}}',
			'{{FrontSide}}<hr>{{cloze:Text}}'
		);

		expect(result.frontHtml).toContain('alpha');
		expect(result.frontHtml).toContain('cloze-blank');
		expect(result.backHtml).toContain('<span class="cloze-answer">beta</span>');
		expect(result.backHtml).not.toContain('{{cloze:Text}}');
	});
});

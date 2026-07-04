import { describe, expect, it } from 'vitest';
import { renderCard } from './card-renderer';
import { clientCardSanitizer as s } from './card-sanitize';
import type { NoteField } from '../types';

function fieldsJson(fields: NoteField[]): string {
	return JSON.stringify(fields);
}

describe('renderCard', () => {
	it('renders only the active cloze ordinal as blank on the front', () => {
		const fields = fieldsJson([
			{ name: 'Text', value: '{{c1::alpha}} {{c2::beta::B hint}}' }
		]);

		const first = renderCard(fields, 'cloze', 0, null, null, s);
		const second = renderCard(fields, 'cloze', 1, null, null, s);

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
			'{{FrontSide}}<section>{{text:Front}} / {{Back}}</section><script>alert(1)</script>',
			s
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
			'{{FrontSide}}<hr>{{cloze:Text}}',
			s
		);

		expect(result.frontHtml).toContain('alpha');
		expect(result.frontHtml).toContain('cloze-blank');
		expect(result.backHtml).toContain('<span class="cloze-answer">beta</span>');
		expect(result.backHtml).not.toContain('{{cloze:Text}}');
	});

	it('exposes fields beyond front/back of a template-less card as extras, not in TTS text', () => {
		const fields = fieldsJson([
			{ name: 'Front', value: 'Capital of France?' },
			{ name: 'Back', value: 'Paris' },
			{ name: 'Source', value: 'Geography 101, p. 12' },
			{ name: 'Empty', value: '   ' }
		]);

		const result = renderCard(fields, 'basic', 0, null, null, s);

		expect(result.extrasHtml).toContain('Source');
		expect(result.extrasHtml).toContain('Geography 101, p. 12');
		expect(result.extrasHtml).not.toContain('Empty');
		expect(result.extrasHtml).not.toContain('Paris');
		expect(result.back).toBe('Paris');
		expect(result.backHtml).not.toContain('Geography');
	});

	it('treats template-referenced fields as displayed and the rest as extras', () => {
		const fields = fieldsJson([
			{ name: 'Front', value: 'Q' },
			{ name: 'Back', value: 'A' },
			{ name: 'Hint', value: 'shown via text filter' },
			{ name: 'Source', value: 'hidden source' },
			{ name: 'Gate', value: 'conditional-only' },
			{ name: 'Typed', value: 'typed answer' }
		]);

		const result = renderCard(
			fields,
			'basic',
			0,
			'{{Front}}{{type:Typed}}',
			'{{FrontSide}}<hr>{{Back}} {{text:Hint}}{{#Gate}}gated{{/Gate}}',
			s
		);

		expect(result.extrasHtml).not.toContain('Front');
		expect(result.extrasHtml).not.toContain('shown via text filter');
		expect(result.extrasHtml).toContain('hidden source');
		// Conditionals only gate content and {{type:...}} is stripped by this renderer —
		// neither displays the field, so both land in extras.
		expect(result.extrasHtml).toContain('conditional-only');
		expect(result.extrasHtml).toContain('typed answer');
	});

	it('exposes Back Extra of a template-less cloze card as extras', () => {
		const fields = fieldsJson([
			{ name: 'Text', value: '{{c1::alpha}}' },
			{ name: 'Back Extra', value: 'mnemonic here' }
		]);

		const result = renderCard(fields, 'cloze', 0, null, null, s);

		expect(result.back).toBe('alpha');
		expect(result.extrasHtml).toContain('Back Extra');
		expect(result.extrasHtml).toContain('mnemonic here');
	});

	it('escapes markup in extra field names and sanitizes extra field values', () => {
		const fields = fieldsJson([
			{ name: 'Front', value: 'Q' },
			{ name: 'Back', value: 'A' },
			{ name: '<img src=x onerror=alert(1)>', value: '<script>alert(2)</script>safe' }
		]);

		const result = renderCard(fields, 'basic', 0, null, null, s);

		// The name survives only as escaped text — never as a live tag.
		expect(result.extrasHtml).not.toContain('<img');
		expect(result.extrasHtml).toContain('&lt;img');
		expect(result.extrasHtml).not.toContain('<script');
		expect(result.extrasHtml).toContain('safe');
	});

	it('returns empty extras when every field is displayed', () => {
		const fields = fieldsJson([
			{ name: 'Front', value: 'Q' },
			{ name: 'Back', value: 'A' }
		]);

		expect(renderCard(fields, 'basic', 0, null, null, s).extrasHtml).toBe('');
	});

	it('neutralizes XSS created by composing a sanitized template with a sanitized field', () => {
		// Each piece is "safe" alone: the template is a valid <img>, and the field is plain
		// text. String substitution splices them into an <img> with an onerror handler — the
		// render-time sanitizer must strip it.
		const fields = fieldsJson([{ name: 'Image', value: 'x" onerror="alert(1)' }]);

		const result = renderCard(fields, 'basic', 0, '<img src="{{Image}}">', null, s);

		expect(result.frontHtml).not.toContain('onerror');
		expect(result.frontHtml.toLowerCase()).not.toContain('alert(1)');
	});
});

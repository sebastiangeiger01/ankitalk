import { sanitizeAndRewriteCardHtml, sanitizeCardHtml } from '../sanitize';
import type { NoteField } from '../types';

/**
 * Strip HTML tags and decode entities for TTS.
 */
export function stripHtml(html: string): string {
	const div = document.createElement('div');
	div.innerHTML = sanitizeCardHtml(html);
	return div.textContent ?? '';
}

/**
 * Handle cloze deletions: {{c1::answer::hint}} -> "blank" for question, "answer" for answer.
 */
function processCloze(text: string, showAnswer: boolean, clozeNumber?: number): string {
	return text.replace(/\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g, (_match, rawNumber, answer, hint) => {
		const isActive = clozeNumber === undefined || Number(rawNumber) === clozeNumber;
		if (showAnswer || !isActive) return answer;
		return hint || 'blank';
	});
}

/**
 * Process cloze HTML: wrap cloze answers in a styled span for display.
 */
function processClozeHtml(text: string, showAnswer: boolean, clozeNumber?: number): string {
	return text.replace(/\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g, (_match, rawNumber, answer, hint) => {
		const isActive = clozeNumber === undefined || Number(rawNumber) === clozeNumber;
		if (showAnswer || !isActive) {
			return isActive ? `<span class="cloze-answer">${answer}</span>` : answer;
		}
		return `<span class="cloze-blank">[${hint || '...'}]</span>`;
	});
}

function fieldMap(fields: NoteField[]): Map<string, string> {
	return new Map(fields.map((field) => [field.name, field.value]));
}

function fieldIsFilled(fields: Map<string, string>, name: string): boolean {
	return stripHtml(fields.get(name) ?? '').trim().length > 0;
}

function applyConditionals(template: string, fields: Map<string, string>): string {
	let output = template;
	for (let i = 0; i < 10; i++) {
		const next = output
			.replace(/\{\{#([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_match, name, body) =>
				fieldIsFilled(fields, String(name).trim()) ? body : ''
			)
			.replace(/\{\{\^([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_match, name, body) =>
				fieldIsFilled(fields, String(name).trim()) ? '' : body
			);
		if (next === output) break;
		output = next;
	}
	return output;
}

function renderTemplate(
	template: string,
	fields: NoteField[],
	frontSide: string,
	clozeNumber: number,
	showAnswer: boolean
): string {
	const fieldsByName = fieldMap(fields);
	let output = applyConditionals(template, fieldsByName);

	output = output.replace(/\{\{FrontSide\}\}/g, frontSide);
	output = output.replace(/\{\{type:[^}]+\}\}/g, '');
	output = output.replace(/\{\{cloze:([^}]+)\}\}/g, (_match, rawName) => {
		const name = String(rawName).trim();
		return processClozeHtml(fieldsByName.get(name) ?? '', showAnswer, clozeNumber);
	});
	output = output.replace(/\{\{text:([^}]+)\}\}/g, (_match, rawName) => {
		const name = String(rawName).trim();
		return stripHtml(fieldsByName.get(name) ?? '');
	});
	output = output.replace(/\{\{([^}]+)\}\}/g, (_match, rawName) => {
		const name = String(rawName).trim();
		return fieldsByName.get(name) ?? '';
	});

	return output;
}

/**
 * Parse card fields and extract front/back as both HTML (display) and plain text (TTS).
 */
export function renderCard(
	fieldsJson: string,
	cardType: string,
	ordinal = 0,
	frontTemplate?: string | null,
	backTemplate?: string | null
): { front: string; back: string; frontHtml: string; backHtml: string } {
	let fields: NoteField[];
	try {
		fields = JSON.parse(fieldsJson);
	} catch {
		return { front: 'Error reading card', back: '', frontHtml: 'Error reading card', backHtml: '' };
	}

	if (fields.length === 0) {
		return { front: 'Empty card', back: '', frontHtml: 'Empty card', backHtml: '' };
	}

	const firstValue = fields[0]?.value ?? '';
	const isCloze = cardType === 'cloze' || /\{\{c\d+::/.test(firstValue);
	const clozeNumber = ordinal + 1;

	if (frontTemplate || backTemplate) {
		const rawFront = frontTemplate
			? renderTemplate(frontTemplate, fields, '', clozeNumber, false)
			: isCloze
				? processClozeHtml(firstValue, false, clozeNumber)
				: fields[0]?.value ?? '';
		const frontHtml = sanitizeAndRewriteCardHtml(rawFront);
		const rawBack = backTemplate
			? renderTemplate(backTemplate, fields, frontHtml, clozeNumber, true)
			: isCloze
				? processClozeHtml(firstValue, true, clozeNumber)
				: fields[1]?.value ?? fields[0]?.value ?? '';
		const backHtml = sanitizeAndRewriteCardHtml(rawBack);
		return {
			front: stripHtml(frontHtml),
			back: stripHtml(backHtml),
			frontHtml,
			backHtml
		};
	}

	if (isCloze) {
		return {
			front: stripHtml(processCloze(firstValue, false, clozeNumber)),
			back: stripHtml(processCloze(firstValue, true, clozeNumber)),
			frontHtml: sanitizeAndRewriteCardHtml(processClozeHtml(firstValue, false, clozeNumber)),
			backHtml: sanitizeAndRewriteCardHtml(processClozeHtml(firstValue, true, clozeNumber))
		};
	}

	const rawFront = fields[0]?.value ?? '';
	const rawBack = fields[1]?.value ?? rawFront;
	return {
		front: stripHtml(rawFront),
		back: stripHtml(rawBack),
		frontHtml: sanitizeAndRewriteCardHtml(rawFront),
		backHtml: sanitizeAndRewriteCardHtml(rawBack)
	};
}

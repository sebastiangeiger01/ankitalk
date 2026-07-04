import type { NoteField } from '../types';

/**
 * Card HTML sanitizer, injected so `renderCard` stays isomorphic: the browser passes a
 * DOMPurify-backed implementation (small, native parsing) and the server passes the
 * `sanitize-html`-backed one (no DOM required). Both must sanitize the *composed* output —
 * combining individually-safe fields and templates can still produce dangerous HTML.
 */
export interface CardHtmlSanitizer {
	/** Sanitize composed card HTML and rewrite relative media URLs to the media endpoint. */
	sanitizeAndRewrite(html: string): string;
	/** Strip all markup to plain text (for TTS). */
	toText(html: string): string;
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

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Field names a template actually renders. Conditional markers ({{#F}}/{{^F}}/{{/F}})
 * only gate content, and {{type:F}} is stripped by this renderer — neither makes the
 * field's content visible, so both are excluded and such fields fall through to the
 * extras section.
 */
function collectDisplayedFieldNames(template: string): Set<string> {
	const names = new Set<string>();
	for (const match of template.matchAll(/\{\{([^}]+)\}\}/g)) {
		const inner = match[1].trim();
		if (!inner || inner.startsWith('#') || inner.startsWith('^') || inner.startsWith('/')) continue;
		const segments = inner.split(':').map((s) => s.trim());
		if (segments.length > 1 && segments[0] === 'type') continue;
		names.add(segments[segments.length - 1]);
	}
	return names;
}

/**
 * Cards routinely carry fields the displayed side never shows (Source, Back Extra,
 * a template-less note's third field, …). Render every non-empty field the front/back
 * didn't display as a labeled block so the information isn't silently lost in review.
 * Kept separate from `back` so TTS never reads them aloud.
 */
function buildExtrasHtml(
	fields: NoteField[],
	displayed: Set<string>,
	sanitizer: CardHtmlSanitizer
): string {
	const extras = fields.filter(
		(field) => !displayed.has(field.name) && sanitizer.toText(field.value).trim().length > 0
	);
	if (extras.length === 0) return '';
	const html = extras
		.map(
			(field) =>
				`<div class="extra-field"><div class="extra-field-name">${escapeHtml(field.name)}</div><div class="extra-field-value">${field.value}</div></div>`
		)
		.join('');
	return sanitizer.sanitizeAndRewrite(html);
}

function fieldIsFilled(fields: Map<string, string>, name: string, sanitizer: CardHtmlSanitizer): boolean {
	return sanitizer.toText(fields.get(name) ?? '').trim().length > 0;
}

function applyConditionals(template: string, fields: Map<string, string>, sanitizer: CardHtmlSanitizer): string {
	let output = template;
	for (let i = 0; i < 10; i++) {
		const next = output
			.replace(/\{\{#([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_match, name, body) =>
				fieldIsFilled(fields, String(name).trim(), sanitizer) ? body : ''
			)
			.replace(/\{\{\^([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_match, name, body) =>
				fieldIsFilled(fields, String(name).trim(), sanitizer) ? '' : body
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
	showAnswer: boolean,
	sanitizer: CardHtmlSanitizer
): string {
	const fieldsByName = fieldMap(fields);
	let output = applyConditionals(template, fieldsByName, sanitizer);

	output = output.replace(/\{\{FrontSide\}\}/g, frontSide);
	output = output.replace(/\{\{type:[^}]+\}\}/g, '');
	output = output.replace(/\{\{cloze:([^}]+)\}\}/g, (_match, rawName) => {
		const name = String(rawName).trim();
		return processClozeHtml(fieldsByName.get(name) ?? '', showAnswer, clozeNumber);
	});
	output = output.replace(/\{\{text:([^}]+)\}\}/g, (_match, rawName) => {
		const name = String(rawName).trim();
		return sanitizer.toText(fieldsByName.get(name) ?? '');
	});
	output = output.replace(/\{\{([^}]+)\}\}/g, (_match, rawName) => {
		const name = String(rawName).trim();
		return fieldsByName.get(name) ?? '';
	});

	return output;
}

/**
 * Parse card fields and extract front/back as both HTML (display) and plain text (TTS).
 * `sanitizer` is injected so this stays usable on both the client and the server.
 */
export function renderCard(
	fieldsJson: string,
	cardType: string,
	ordinal: number,
	frontTemplate: string | null | undefined,
	backTemplate: string | null | undefined,
	sanitizer: CardHtmlSanitizer
): { front: string; back: string; frontHtml: string; backHtml: string; extrasHtml: string } {
	let fields: NoteField[];
	try {
		fields = JSON.parse(fieldsJson);
	} catch {
		return { front: 'Error reading card', back: '', frontHtml: 'Error reading card', backHtml: '', extrasHtml: '' };
	}

	if (fields.length === 0) {
		return { front: 'Empty card', back: '', frontHtml: 'Empty card', backHtml: '', extrasHtml: '' };
	}

	const firstValue = fields[0]?.value ?? '';
	const isCloze = cardType === 'cloze' || /\{\{c\d+::/.test(firstValue);
	const clozeNumber = ordinal + 1;

	if (frontTemplate || backTemplate) {
		const displayed = collectDisplayedFieldNames(`${frontTemplate ?? ''}\n${backTemplate ?? ''}`);
		// Fallback sides render fields directly without going through a template.
		if (!frontTemplate && fields[0]) displayed.add(fields[0].name);
		if (!backTemplate) {
			const backField = isCloze ? fields[0] : fields[1] ?? fields[0];
			if (backField) displayed.add(backField.name);
		}
		const rawFront = frontTemplate
			? renderTemplate(frontTemplate, fields, '', clozeNumber, false, sanitizer)
			: isCloze
				? processClozeHtml(firstValue, false, clozeNumber)
				: fields[0]?.value ?? '';
		const frontHtml = sanitizer.sanitizeAndRewrite(rawFront);
		const rawBack = backTemplate
			? renderTemplate(backTemplate, fields, frontHtml, clozeNumber, true, sanitizer)
			: isCloze
				? processClozeHtml(firstValue, true, clozeNumber)
				: fields[1]?.value ?? fields[0]?.value ?? '';
		const backHtml = sanitizer.sanitizeAndRewrite(rawBack);
		return {
			front: sanitizer.toText(frontHtml),
			back: sanitizer.toText(backHtml),
			frontHtml,
			backHtml,
			extrasHtml: buildExtrasHtml(fields, displayed, sanitizer)
		};
	}

	if (isCloze) {
		const displayed = new Set(fields[0] ? [fields[0].name] : []);
		return {
			front: sanitizer.toText(processCloze(firstValue, false, clozeNumber)),
			back: sanitizer.toText(processCloze(firstValue, true, clozeNumber)),
			frontHtml: sanitizer.sanitizeAndRewrite(processClozeHtml(firstValue, false, clozeNumber)),
			backHtml: sanitizer.sanitizeAndRewrite(processClozeHtml(firstValue, true, clozeNumber)),
			extrasHtml: buildExtrasHtml(fields, displayed, sanitizer)
		};
	}

	const rawFront = fields[0]?.value ?? '';
	const rawBack = fields[1]?.value ?? rawFront;
	const displayed = new Set<string>();
	if (fields[0]) displayed.add(fields[0].name);
	const backField = fields[1] ?? fields[0];
	if (backField) displayed.add(backField.name);
	return {
		front: sanitizer.toText(rawFront),
		back: sanitizer.toText(rawBack),
		frontHtml: sanitizer.sanitizeAndRewrite(rawFront),
		backHtml: sanitizer.sanitizeAndRewrite(rawBack),
		extrasHtml: buildExtrasHtml(fields, displayed, sanitizer)
	};
}

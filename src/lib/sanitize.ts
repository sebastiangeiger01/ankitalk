import sanitizeHtml from 'sanitize-html';

export const IMPORT_LIMITS = {
	maxApkgBytes: 100 * 1024 * 1024,
	maxUnzippedBytes: 300 * 1024 * 1024,
	maxDecks: 500,
	maxNotes: 100_000,
	maxCards: 200_000,
	maxFieldsPerNote: 50,
	maxFieldBytes: 256 * 1024,
	maxTagsBytes: 8 * 1024,
	maxMediaFiles: 5_000,
	maxMediaFileBytes: 25 * 1024 * 1024,
	maxMediaTotalBytes: 200 * 1024 * 1024,
	maxFilenameBytes: 240
} as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const colorPattern =
	/^(#[0-9a-f]{3,8}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)|rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+)\s*\)|[a-z]+)$/i;

export function byteLength(value: string): number {
	return textEncoder.encode(value).byteLength;
}

export function assertMaxBytes(value: string, maxBytes: number, label: string): void {
	if (byteLength(value) > maxBytes) {
		throw new Error(`${label} is too large`);
	}
}

export function sanitizePlainText(value: unknown, maxBytes = IMPORT_LIMITS.maxFieldBytes): string {
	const text = String(value ?? '')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
		.trim();
	assertMaxBytes(text, maxBytes, 'Text');
	return text;
}

export function mediaFilenameSafetyError(filename: string): string | null {
	if (!filename) return 'Media filename is empty';
	if (filename !== filename.trim()) {
		return `Media filename has leading or trailing whitespace: ${filename}`;
	}
	if (byteLength(filename) > IMPORT_LIMITS.maxFilenameBytes) {
		return `Media filename is too long: ${filename}`;
	}
	if (/[\u0000-\u001f\u007f]/.test(filename)) {
		return `Media filename contains control characters: ${filename}`;
	}
	if (filename.startsWith('.') || filename.endsWith('.')) {
		return `Media filename must not start or end with a dot: ${filename}`;
	}
	if (filename.includes('..')) {
		return `Media filename contains path traversal (".."): ${filename}`;
	}
	if (filename.includes('/') || filename.includes('\\')) {
		return `Media filename must not include folders or path separators: ${filename}`;
	}
	if (filename.includes(':')) {
		return `Media filename must not include drive or URL separators (:): ${filename}`;
	}
	if (/[<>|?*"`]/g.test(filename)) {
		return `Media filename contains unsupported filesystem characters: ${filename}`;
	}
	return null;
}

export function isSafeMediaFilename(filename: string): boolean {
	return mediaFilenameSafetyError(filename) === null;
}

export function mediaContentTypeForFilename(filename: string): string | null {
	const ext = filename.split('.').pop()?.toLowerCase();
	switch (ext) {
		case 'svg':
			return 'image/svg+xml';
		case 'png':
			return 'image/png';
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'gif':
			return 'image/gif';
		case 'webp':
			return 'image/webp';
		case 'bmp':
			return 'image/bmp';
		case 'mp3':
			return 'audio/mpeg';
		case 'wav':
			return 'audio/wav';
		case 'ogg':
		case 'oga':
			return 'audio/ogg';
		case 'm4a':
			return 'audio/mp4';
		case 'aac':
			return 'audio/aac';
		case 'flac':
			return 'audio/flac';
		case 'opus':
			return 'audio/opus';
		case 'mp4':
			return 'video/mp4';
		case 'webm':
			return 'video/webm';
		default:
			return null;
	}
}

export function isSvgMediaFilename(filename: string): boolean {
	return filename.split('.').pop()?.toLowerCase() === 'svg';
}

export function mediaContentTypeSafetyError(filename: string): string | null {
	if (mediaContentTypeForFilename(filename)) return null;
	return `Unsupported media file type: ${filename}. Supported media types are SVG, raster images, audio, and video files.`;
}

const svgTagNames = [
	'a',
	'animate',
	'animateMotion',
	'animateTransform',
	'circle',
	'clipPath',
	'defs',
	'desc',
	'ellipse',
	'feBlend',
	'feColorMatrix',
	'feComponentTransfer',
	'feComposite',
	'feConvolveMatrix',
	'feDiffuseLighting',
	'feDisplacementMap',
	'feDistantLight',
	'feDropShadow',
	'feFlood',
	'feFuncA',
	'feFuncB',
	'feFuncG',
	'feFuncR',
	'feGaussianBlur',
	'feImage',
	'feMerge',
	'feMergeNode',
	'feMorphology',
	'feOffset',
	'fePointLight',
	'feSpecularLighting',
	'feSpotLight',
	'feTile',
	'feTurbulence',
	'filter',
	'g',
	'image',
	'line',
	'linearGradient',
	'marker',
	'mask',
	'metadata',
	'mpath',
	'path',
	'pattern',
	'polygon',
	'polyline',
	'radialGradient',
	'rect',
	'set',
	'stop',
	'svg',
	'switch',
	'symbol',
	'text',
	'textPath',
	'title',
	'tspan',
	'use'
] as const;

const svgTagNameByLowercase = new Map(svgTagNames.map((tagName) => [tagName.toLowerCase(), tagName]));

const svgAttributeNames = new Set(
	[
		'accent-height',
		'accumulate',
		'additive',
		'alignment-baseline',
		'alphabetic',
		'amplitude',
		'arabic-form',
		'ascent',
		'attributename',
		'attributetype',
		'azimuth',
		'basefrequency',
		'baseline-shift',
		'begin',
		'bias',
		'by',
		'calcmode',
		'class',
		'clip',
		'clip-path',
		'clippathunits',
		'clip-rule',
		'color',
		'color-interpolation',
		'color-interpolation-filters',
		'color-rendering',
		'cx',
		'cy',
		'd',
		'diffuseconstant',
		'direction',
		'display',
		'divisor',
		'dominant-baseline',
		'dur',
		'dx',
		'dy',
		'edgemode',
		'elevation',
		'end',
		'exponent',
		'fill',
		'fill-opacity',
		'fill-rule',
		'filter',
		'filterunits',
		'flood-color',
		'flood-opacity',
		'font-family',
		'font-size',
		'font-stretch',
		'font-style',
		'font-variant',
		'font-weight',
		'fr',
		'from',
		'fx',
		'fy',
		'glyph-orientation-horizontal',
		'glyph-orientation-vertical',
		'gradienttransform',
		'gradientunits',
		'height',
		'href',
		'id',
		'image-rendering',
		'in',
		'in2',
		'intercept',
		'k',
		'k1',
		'k2',
		'k3',
		'k4',
		'kernelmatrix',
		'kernelunitlength',
		'keypoints',
		'keysplines',
		'keytimes',
		'lang',
		'lengthadjust',
		'letter-spacing',
		'lighting-color',
		'limitingconeangle',
		'marker-end',
		'marker-mid',
		'marker-start',
		'markerheight',
		'markerunits',
		'markerwidth',
		'mask',
		'maskcontentunits',
		'maskunits',
		'max',
		'media',
		'method',
		'min',
		'mode',
		'numoctaves',
		'offset',
		'opacity',
		'operator',
		'order',
		'orient',
		'origin',
		'overflow',
		'paint-order',
		'path',
		'pathlength',
		'patterncontentunits',
		'patterntransform',
		'patternunits',
		'points',
		'preservealpha',
		'preserveaspectratio',
		'primitiveunits',
		'r',
		'radius',
		'refx',
		'refy',
		'repeatcount',
		'repeatdur',
		'requiredextensions',
		'requiredfeatures',
		'restart',
		'result',
		'rotate',
		'rx',
		'ry',
		'scale',
		'seed',
		'shape-rendering',
		'slope',
		'spacing',
		'specularconstant',
		'specularexponent',
		'spreadmethod',
		'stddeviation',
		'stitchtiles',
		'stop-color',
		'stop-opacity',
		'stroke',
		'stroke-dasharray',
		'stroke-dashoffset',
		'stroke-linecap',
		'stroke-linejoin',
		'stroke-miterlimit',
		'stroke-opacity',
		'stroke-width',
		'style',
		'surfacescale',
		'systemlanguage',
		'tabindex',
		'tablevalues',
		'target',
		'targetx',
		'targety',
		'text-anchor',
		'text-decoration',
		'text-rendering',
		'textlength',
		'to',
		'transform',
		'transform-origin',
		'type',
		'values',
		'vector-effect',
		'version',
		'viewbox',
		'visibility',
		'width',
		'word-spacing',
		'writing-mode',
		'x',
		'x1',
		'x2',
		'xchannelselector',
		'xlink:href',
		'xml:lang',
		'xml:space',
		'xmlns',
		'xmlns:xlink',
		'y',
		'y1',
		'y2',
		'ychannelselector',
		'z'
	].map((attributeName) => attributeName.toLowerCase())
);

const svgStyleProperties = new Set(
	[
		'alignment-baseline',
		'baseline-shift',
		'clip-path',
		'clip-rule',
		'color',
		'color-interpolation',
		'color-interpolation-filters',
		'color-rendering',
		'direction',
		'display',
		'dominant-baseline',
		'fill',
		'fill-opacity',
		'fill-rule',
		'filter',
		'flood-color',
		'flood-opacity',
		'font-family',
		'font-size',
		'font-stretch',
		'font-style',
		'font-variant',
		'font-weight',
		'image-rendering',
		'isolation',
		'letter-spacing',
		'lighting-color',
		'marker-end',
		'marker-mid',
		'marker-start',
		'mask',
		'mix-blend-mode',
		'opacity',
		'overflow',
		'paint-order',
		'shape-rendering',
		'stop-color',
		'stop-opacity',
		'stroke',
		'stroke-dasharray',
		'stroke-dashoffset',
		'stroke-linecap',
		'stroke-linejoin',
		'stroke-miterlimit',
		'stroke-opacity',
		'stroke-width',
		'text-anchor',
		'text-decoration',
		'text-rendering',
		'transform',
		'transform-origin',
		'vector-effect',
		'visibility',
		'white-space',
		'word-spacing',
		'writing-mode'
	].map((propertyName) => propertyName.toLowerCase())
);

const svgReferenceAttributes = new Set([
	'clip-path',
	'filter',
	'marker-end',
	'marker-mid',
	'marker-start',
	'mask'
]);

const localSvgReferencePattern = /^#[A-Za-z0-9_.:-]+$/;
const localSvgUrlPattern = /^url\(\s*(['"]?)#[A-Za-z0-9_.:-]+\1\s*\)$/i;
const svgUrlTokenPattern = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const dataRasterImagePattern = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;
const unsafeSvgValuePattern = /(?:javascript|vbscript):|data:text\/html|<\s*(?:script|iframe|object|embed)\b/i;

function hasOnlyLocalSvgUrls(value: string): boolean {
	const matches = [...value.matchAll(svgUrlTokenPattern)];
	return matches.every((match) => localSvgUrlPattern.test(match[0]));
}

function isSafeSvgHref(value: string): boolean {
	const trimmed = value.trim();
	return localSvgReferencePattern.test(trimmed) || dataRasterImagePattern.test(trimmed);
}

function isSafeSvgHrefList(value: string): boolean {
	return value
		.split(';')
		.map((item) => item.trim())
		.filter(Boolean)
		.every((item) => isSafeSvgHref(item));
}

function isSafeSvgValue(attributeName: string, value: string): boolean {
	if (value.length > 8_192) return false;
	if (unsafeSvgValuePattern.test(value)) return false;
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return false;
	if (svgUrlTokenPattern.test(value)) {
		svgUrlTokenPattern.lastIndex = 0;
		if (!hasOnlyLocalSvgUrls(value)) return false;
		svgUrlTokenPattern.lastIndex = 0;
	}

	const lowerName = attributeName.toLowerCase();
	if (lowerName === 'href' || lowerName === 'xlink:href' || lowerName === 'src') {
		return isSafeSvgHref(value);
	}
	if (svgReferenceAttributes.has(lowerName)) {
		return value === 'none' || localSvgUrlPattern.test(value.trim());
	}
	if (lowerName === 'target') return false;
	if (lowerName === 'xmlns') return value === 'http://www.w3.org/2000/svg';
	if (lowerName === 'xmlns:xlink') return value === 'http://www.w3.org/1999/xlink';

	return true;
}

function sanitizeSvgStyle(value: string): string | undefined {
	const safeDeclarations = value
		.split(';')
		.map((declaration) => declaration.trim())
		.filter(Boolean)
		.flatMap((declaration) => {
			const separator = declaration.indexOf(':');
			if (separator === -1) return [];

			const property = declaration.slice(0, separator).trim().toLowerCase();
			const propertyValue = declaration.slice(separator + 1).trim();
			if (!svgStyleProperties.has(property)) return [];
			if (!isSafeSvgValue(property, propertyValue)) return [];
			return [`${property}: ${propertyValue}`];
		});

	return safeDeclarations.length ? safeDeclarations.join('; ') : undefined;
}

function sanitizeSvgAttributes(
	tagName: string,
	attribs: Record<string, string>
): Record<string, string> {
	const safeAttributes: Record<string, string> = {};
	const animatedAttributeName = String(
		attribs.attributeName ?? attribs.attributename ?? ''
	).toLowerCase();
	const animatesHref =
		['animate', 'set'].includes(tagName.toLowerCase()) &&
		['href', 'xlink:href', 'src'].includes(animatedAttributeName);

	for (const [attributeName, rawValue] of Object.entries(attribs)) {
		if (!/^[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(attributeName)) continue;
		if (/^on/i.test(attributeName)) continue;
		const lowerName = attributeName.toLowerCase();
		if (
			!svgAttributeNames.has(lowerName) &&
			!lowerName.startsWith('aria-') &&
			!lowerName.startsWith('data-')
		) {
			continue;
		}

		const value = String(rawValue ?? '').trim();
		if (lowerName === 'style') {
			const safeStyle = sanitizeSvgStyle(value);
			if (safeStyle) safeAttributes[attributeName] = safeStyle;
			continue;
		}
		if (!isSafeSvgValue(lowerName, value)) continue;
		if (
			animatesHref &&
			['from', 'to', 'by', 'values'].includes(lowerName) &&
			!isSafeSvgHrefList(value)
		) {
			continue;
		}

		safeAttributes[attributeName] = value;
	}

	return safeAttributes;
}

export function sanitizeSvgMarkup(value: string): string {
	assertMaxBytes(value, IMPORT_LIMITS.maxMediaFileBytes, 'SVG media file');

	const clean = sanitizeHtml(value.replace(/^\uFEFF/, ''), {
		allowedTags: Array.from(svgTagNames),
		allowedAttributes: false,
		allowedSchemes: false,
		allowProtocolRelative: false,
		disallowedTagsMode: 'discard',
		nonTextTags: [
			'script',
			'style',
			'textarea',
			'option',
			'foreignObject',
			'foreignobject',
			'iframe',
			'object',
			'embed',
			'link',
			'meta'
		],
		parser: {
			lowerCaseTags: false,
			lowerCaseAttributeNames: false,
			xmlMode: true
		},
		transformTags: {
			'*': (tagName, attribs) => {
				const canonicalTagName = svgTagNameByLowercase.get(tagName.toLowerCase()) ?? tagName;
				return {
					tagName: canonicalTagName,
					attribs: sanitizeSvgAttributes(canonicalTagName, attribs)
				};
			}
		}
	}).trim();

	if (!/^<svg(?:\s|>)/i.test(clean)) {
		throw new Error('Invalid SVG media file');
	}

	return clean.replace(/^<svg\b(?![^>]*\sxmlns=)/, '<svg xmlns="http://www.w3.org/2000/svg"');
}

export function svgMediaContentSecurityPolicy(): string {
	return [
		'sandbox',
		"default-src 'none'",
		"script-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'",
		"img-src data: blob:",
		"style-src 'unsafe-inline'"
	].join('; ');
}

export async function sanitizeMediaBlob(filename: string, blob: Blob): Promise<Blob> {
	const contentType = mediaContentTypeForFilename(filename);
	if (!contentType) throw new Error(mediaContentTypeSafetyError(filename) ?? 'Unsupported media file type');
	if (!isSvgMediaFilename(filename)) return blob;

	const svgText = sanitizeSvgMarkup(await blob.text());
	return new Blob([svgText], { type: contentType });
}

export function sanitizeMediaBytes(filename: string, bytes: Uint8Array): Blob {
	const contentType = mediaContentTypeForFilename(filename);
	if (!contentType) throw new Error(mediaContentTypeSafetyError(filename) ?? 'Unsupported media file type');
	if (!isSvgMediaFilename(filename)) {
		const mediaArrayBuffer = bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength
		) as ArrayBuffer;
		return new Blob([mediaArrayBuffer], { type: contentType });
	}

	return new Blob([sanitizeSvgMarkup(textDecoder.decode(bytes))], { type: contentType });
}

function normalizeMediaFilename(filename: string): string | null {
	const trimmed = filename.trim().replace(/^\.\//, '');
	if (!isSafeMediaFilename(trimmed)) return null;
	return trimmed;
}

export function sanitizeCardHtml(value: unknown): string {
	const html = String(value ?? '');
	assertMaxBytes(html, IMPORT_LIMITS.maxFieldBytes, 'Card field');

	return sanitizeHtml(html, {
		allowedTags: [
			'a',
			'abbr',
			'audio',
			'b',
			'blockquote',
			'br',
			'caption',
			'code',
			'col',
			'colgroup',
			'dd',
			'del',
			'div',
			'dl',
			'dt',
			'em',
			'h1',
			'h2',
			'h3',
			'h4',
			'h5',
			'h6',
			'hr',
			'i',
			'img',
			'ins',
			'kbd',
			'li',
			'mark',
			'ol',
			'p',
			'pre',
			'q',
			'rb',
			'rp',
			'rt',
			'rtc',
			'ruby',
			's',
			'samp',
			'small',
			'source',
			'span',
			'strong',
			'sub',
			'sup',
			'table',
			'tbody',
			'td',
			'tfoot',
			'th',
			'thead',
			'tr',
			'u',
			'ul'
		],
		allowedAttributes: {
			a: ['href', 'name', 'rel', 'title'],
			audio: ['src', 'controls', 'title'],
			img: ['src', 'alt', 'title', 'width', 'height'],
			source: ['src', 'type'],
			'*': ['class', 'dir', 'lang', 'style', 'title']
		},
		allowedSchemes: ['http', 'https', 'mailto'],
		allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
		allowProtocolRelative: false,
		disallowedTagsMode: 'discard',
		parseStyleAttributes: true,
		allowedStyles: {
			'*': {
				color: [colorPattern],
				'background-color': [colorPattern],
				'font-size': [/^\d+(\.\d+)?(px|em|rem|%)$/],
				'font-style': [/^(italic|normal|oblique)$/],
				'font-weight': [/^(normal|bold|bolder|lighter|[1-9]00)$/],
				'text-align': [/^(left|right|center|justify|start|end)$/],
				'text-decoration': [/^(none|underline|line-through|overline)$/],
				'vertical-align': [/^(baseline|sub|super|text-top|text-bottom|middle|top|bottom)$/],
				'white-space': [/^(normal|nowrap|pre|pre-wrap|pre-line)$/]
			}
		},
		transformTags: {
			a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true)
		}
	}).trim();
}

export function rewriteMediaUrls(html: string): string {
	return html.replace(
		/(<(?:img|audio|source)\b[^>]*\bsrc\s*=\s*["'])(?!https?:\/\/|\/api\/|data:)([^"']+)(["'])/gi,
		(_match, prefix, filename, suffix) => {
			const normalized = normalizeMediaFilename(filename);
			if (!normalized) return `${prefix}${suffix}`;
			return `${prefix}/api/media/${encodeURIComponent(normalized)}${suffix}`;
		}
	);
}

export function sanitizeAndRewriteCardHtml(value: unknown): string {
	return rewriteMediaUrls(sanitizeCardHtml(value));
}

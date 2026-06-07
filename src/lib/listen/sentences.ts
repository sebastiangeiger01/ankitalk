/**
 * Split text into "speech units" — typically one real sentence each, but very short
 * sentences (< MIN_CHARS) merge with the following sentence so we don't waste a TTS
 * call on "Yes." or "Hmm." The result drives both the synthesis (one ElevenLabs call
 * per unit) and the reader UI (one highlight per unit).
 *
 * Hard guarantees (enforced by `assertSentenceCoverage` callers run after):
 *   1. Coverage: concatenating units reproduces the input's non-whitespace content.
 *   2. Order: every unit appears in the input at a strictly increasing position.
 * These together catch the kind of silent content loss that motivated the v1 rewrite.
 */

/** Sentences shorter than this merge into the next; tuned to avoid sub-second TTS calls. */
const MIN_CHARS = 30;

/** ElevenLabs caps a single TTS call at 5000 chars; we stay safely under. */
const SENTENCE_MAX_CHARS = 4500;

const TERMINATOR_RE = /[.!?。！？]/;

/**
 * Sentence-boundary scanner. A terminator only ends a sentence when the next character is
 * whitespace or end-of-string — so "2.1.7", "3.14", "Dr." stay glued to the surrounding
 * sentence instead of becoming false splits.
 */
function scanSentences(text: string): string[] {
	const out: string[] = [];
	const len = text.length;
	let start = 0;

	for (let i = 0; i < len; i++) {
		if (!TERMINATOR_RE.test(text[i])) continue;

		// Consume runs like "?!" or "..." as a single terminator block.
		let j = i;
		while (j + 1 < len && TERMINATOR_RE.test(text[j + 1])) j++;

		const next = j + 1 < len ? text[j + 1] : undefined;
		if (next === undefined || /\s/.test(next)) {
			out.push(text.slice(start, j + 1));
			start = j + 1;
		}
		i = j;
	}

	if (start < len) out.push(text.slice(start));
	return out.map((s) => s.trim()).filter(Boolean);
}

function splitByWords(text: string, maxChars: number): string[] {
	const words = text.split(/\s+/);
	const out: string[] = [];
	let buf = '';
	for (const w of words) {
		if (!buf) {
			buf = w;
		} else if (buf.length + 1 + w.length <= maxChars) {
			buf = `${buf} ${w}`;
		} else {
			out.push(buf);
			buf = w;
		}
	}
	if (buf) out.push(buf);
	// Single word longer than maxChars: hard-slice as last resort (preserves content).
	const safe: string[] = [];
	for (const piece of out) {
		if (piece.length <= maxChars) {
			safe.push(piece);
		} else {
			for (let i = 0; i < piece.length; i += maxChars) safe.push(piece.slice(i, i + maxChars));
		}
	}
	return safe;
}

export interface SplitOptions {
	minChars?: number;
	maxChars?: number;
}

export function splitIntoSentences(text: string, opts?: SplitOptions): string[] {
	const minChars = opts?.minChars ?? MIN_CHARS;
	const maxChars = opts?.maxChars ?? SENTENCE_MAX_CHARS;

	const normalized = text.replace(/\r\n?/g, '\n').trim();
	if (!normalized) return [];

	const raw = scanSentences(normalized);

	const units: string[] = [];
	let buffer = '';

	const flush = () => {
		if (buffer) {
			units.push(buffer);
			buffer = '';
		}
	};

	for (const sentence of raw) {
		// Oversized: flush buffer, split this sentence by words.
		if (sentence.length > maxChars) {
			if (buffer) {
				const merged = `${buffer} ${sentence}`;
				if (merged.length <= maxChars) {
					units.push(merged);
					buffer = '';
					continue;
				}
				flush();
			}
			units.push(...splitByWords(sentence, maxChars));
			continue;
		}

		if (!buffer) {
			if (sentence.length >= minChars) units.push(sentence);
			else buffer = sentence;
			continue;
		}

		// Buffer is open — try to absorb this sentence.
		const merged = `${buffer} ${sentence}`;
		if (merged.length <= maxChars) {
			buffer = merged;
			if (buffer.length >= minChars) flush();
		} else {
			// Doesn't fit: emit buffer as-is (tiny but won't combine), then handle sentence.
			flush();
			if (sentence.length >= minChars) units.push(sentence);
			else buffer = sentence;
		}
	}
	flush();

	return units;
}

/**
 * Verify the splitter neither dropped, reordered, nor invented content. Runs cheaply on
 * normalized whitespace-stripped strings. Throw means: do NOT bill credits, the bug is in
 * the splitter or the input encoding.
 */
export function assertSentenceCoverage(original: string, sentences: string[]): void {
	const strip = (s: string) => s.replace(/\s+/g, '');
	const haystack = strip(original);
	const joined = strip(sentences.join(' '));

	if (haystack !== joined) {
		throw new Error(`splitter dropped or altered content (${haystack.length} → ${joined.length} chars)`);
	}

	let pos = 0;
	for (const s of sentences) {
		const needle = strip(s);
		if (!needle) continue;
		const idx = haystack.indexOf(needle, pos);
		if (idx === -1) {
			throw new Error(`splitter reordered content near "${s.slice(0, 40)}"`);
		}
		pos = idx + needle.length;
	}
}

/**
 * Stable hash for a single sentence + voice configuration. Whitespace is normalized so
 * trivially different newline / spacing produces the same hash, maximizing cache reuse.
 */
export async function hashSentence(
	text: string,
	voiceId: string,
	modelId: string,
	language: string
): Promise<string> {
	const normalized = text.replace(/\s+/g, ' ').trim();
	const payload = JSON.stringify([normalized, voiceId, modelId, language]);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * ElevenLabs returns `mp3_44100_128` (CBR 128 kbps). At that bitrate, 1 second is exactly
 * 16_000 bytes, so 1 ms ≈ 16 bytes. Good enough for sub-frame highlight sync.
 */
export function estimateMp3DurationMs(byteSize: number): number {
	return Math.round(byteSize / 16);
}

/** Rough estimate for uncached sentences so the UI has *something* before generation. */
export function estimateDurationMsFromChars(charCount: number, speed = 1): number {
	// ~12 chars/sec for natural speech; speed-adjusted.
	return Math.round(((charCount / 12) * 1000) / Math.max(0.5, Math.min(2, speed)));
}

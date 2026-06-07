export interface ChunkOptions {
	/** Maximum characters per chunk. Stays under the 5000-char ElevenLabs per-call cap. */
	maxChars?: number;
}

const DEFAULT_MAX_CHARS = 4500;

/** Split a paragraph into sentences, keeping terminators (covers EN + DE punctuation). */
function splitSentences(text: string): string[] {
	const matches = text.match(/[^.!?。！？]+[.!?。！？]+(?=\s|$)|[^.!?。！？]+$/g);
	if (!matches) return [text];
	return matches.map((s) => s.trim()).filter(Boolean);
}

function hardSlice(text: string, maxChars: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < text.length; i += maxChars) {
		out.push(text.slice(i, i + maxChars));
	}
	return out;
}

/** Greedily pack pieces joined by `sep` into chunks ≤ maxChars, recursing on oversized pieces. */
function packPieces(pieces: string[], sep: string, maxChars: number): string[] {
	const chunks: string[] = [];
	let current = '';

	for (const raw of pieces) {
		const piece = raw.trim();
		if (!piece) continue;

		if (piece.length > maxChars) {
			if (current) {
				chunks.push(current);
				current = '';
			}
			chunks.push(...splitToChunks(piece, maxChars));
			continue;
		}

		const candidate = current ? `${current}${sep}${piece}` : piece;
		if (candidate.length <= maxChars) {
			current = candidate;
		} else {
			if (current) chunks.push(current);
			current = piece;
		}
	}

	if (current) chunks.push(current);
	return chunks;
}

function splitToChunks(text: string, maxChars: number): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	if (trimmed.length <= maxChars) return [trimmed];

	const paragraphs = trimmed.split(/\n\s*\n/);
	if (paragraphs.length > 1) return packPieces(paragraphs, '\n\n', maxChars);

	const sentences = splitSentences(trimmed);
	if (sentences.length > 1) return packPieces(sentences, ' ', maxChars);

	const words = trimmed.split(/\s+/);
	if (words.length > 1) return packPieces(words, ' ', maxChars);

	return hardSlice(trimmed, maxChars);
}

/**
 * Split arbitrary text into chunks no larger than `maxChars`, preferring paragraph then
 * sentence then word boundaries so words are never cut (except a single oversized token).
 */
export function chunkText(text: string, opts?: ChunkOptions): string[] {
	const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
	const normalized = text.replace(/\r\n?/g, '\n').trim();
	if (!normalized) return [];
	return splitToChunks(normalized, maxChars);
}

/**
 * Helpers for stitching per-sentence MP3s into one downloadable file.
 *
 * Playback gets away with concatenating ElevenLabs' responses verbatim — browsers resync on
 * the next frame header and skip whatever sits between. A file that leaves the app has a
 * harder job: it may land in a car stereo, a podcast app or an offline player, and those are
 * far less forgiving about metadata blocks appearing partway through a stream.
 */

/**
 * Strip a leading ID3v2 tag, if there is one.
 *
 * An ID3v2 header is `"ID3"`, two version bytes, one flags byte, then four *syncsafe* length
 * bytes — each carrying 7 bits, so the tag body length is `b0<<21 | b1<<14 | b2<<7 | b3`. A
 * footer (flag bit 4) adds another 10 bytes. Everything after that is frame data.
 *
 * A no-op when the tag isn't there, which is the expected case: this is defensive, so that one
 * provider-side change to the response format can't turn every downloaded file into something
 * a strict decoder stumbles over halfway through.
 */
export function stripId3v2(bytes: Uint8Array): Uint8Array {
	if (bytes.length < 10) return bytes;
	if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return bytes; // "ID3"

	// Syncsafe integers never set the high bit; if one is set this isn't a valid tag header.
	const size = bytes.subarray(6, 10);
	if (size.some((b) => b & 0x80)) return bytes;

	const bodyLength = (size[0] << 21) | (size[1] << 14) | (size[2] << 7) | size[3];
	const hasFooter = (bytes[5] & 0x10) !== 0;
	const total = 10 + bodyLength + (hasFooter ? 10 : 0);
	return total >= bytes.length ? new Uint8Array(0) : bytes.subarray(total);
}

/** Characters no common filesystem accepts, plus control characters and trailing dots/spaces. */
const UNSAFE_FILENAME = /[\p{Cc}\p{Cf}<>:"/\\|?*\u007f]/gu;

/**
 * Turn a document title into a safe `.mp3` filename. Keeps the title readable — accents,
 * umlauts and spaces all survive — and only removes what breaks a filesystem or lets a value
 * escape the Content-Disposition header.
 */
export function downloadFilename(title: string, maxLength = 80): string {
	const cleaned = title
		.replace(UNSAFE_FILENAME, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/^\.+/, '')
		.replace(/[. ]+$/, '')
		.slice(0, maxLength)
		.trim()
		.replace(/[. ]+$/, '');
	return `${cleaned || 'audio'}.mp3`;
}

/**
 * Build a `Content-Disposition` value carrying both an ASCII fallback and the real UTF-8 name.
 * Old clients read `filename=`, everything current prefers the RFC 5987 `filename*=`.
 */
export function contentDisposition(filename: string): string {
	const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

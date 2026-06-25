export type KeyValidationResult =
	| { ok: true }
	| { ok: false; status: number; capability: ElevenLabsCapability };

export type ElevenLabsCapability =
	| 'speech_to_text'
	| 'text_to_speech'
	| 'voices_read'
	| 'user_read';

type FetchLike = typeof fetch;

export async function validateElevenLabsKey(
	key: string,
	fetchFn: FetchLike = fetch
): Promise<KeyValidationResult> {
	const tokenResponse = await fetchFn('https://api.elevenlabs.io/v1/single-use-token/realtime_scribe', {
		method: 'POST',
		headers: { 'xi-api-key': key }
	});
	if (!tokenResponse.ok) return { ok: false, status: tokenResponse.status, capability: 'speech_to_text' };

	const voicesResponse = await fetchFn('https://api.elevenlabs.io/v1/voices', {
		headers: { 'xi-api-key': key }
	});
	if (!voicesResponse.ok) return { ok: false, status: voicesResponse.status, capability: 'voices_read' };

	const userResponse = await fetchFn('https://api.elevenlabs.io/v1/user/subscription', {
		headers: { 'xi-api-key': key }
	});
	if (!userResponse.ok) return { ok: false, status: userResponse.status, capability: 'user_read' };

	const ttsResponse = await fetchFn(
		'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_22050_32',
		{
			method: 'POST',
			headers: {
				'xi-api-key': key,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				text: 'OK',
				model_id: 'eleven_flash_v2_5'
			})
		}
	);
	if (!ttsResponse.ok) return { ok: false, status: ttsResponse.status, capability: 'text_to_speech' };

	return { ok: true };
}

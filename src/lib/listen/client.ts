import type { ListenGenerateResponse } from './types';

export class ListenKeyError extends Error {}
export class ListenGenerateError extends Error {}

/**
 * Drive resumable per-segment generation for a document until no segments remain.
 * Calls `onProgress(done, total)` after each batch. Throws ListenKeyError when the
 * ElevenLabs key is missing, ListenGenerateError on a synthesis failure or stall.
 */
export async function runGeneration(
	documentId: string,
	onProgress?: (done: number, total: number) => void
): Promise<void> {
	for (;;) {
		const res = await fetch(`/api/listen/${documentId}/generate`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ batch: 2 })
		});

		if (res.status === 400) throw new ListenKeyError('missing-key');
		if (!res.ok) throw new ListenGenerateError('generate-failed');

		const data = (await res.json()) as ListenGenerateResponse;
		onProgress?.(data.document.doneCount, data.document.segmentCount);

		const failed = data.processed.find((p) => p.status === 'failed');
		if (failed) throw new ListenGenerateError(failed.error || 'generate-failed');

		// No work done but segments remain → stuck; stop to avoid an infinite loop.
		if (data.remaining === 0 || data.processed.length === 0) return;
	}
}

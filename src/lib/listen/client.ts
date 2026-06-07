import type { ListenStatus, SegmentStatus } from './types';

export class ListenKeyError extends Error {
	constructor() {
		super('no-key');
		this.name = 'ListenKeyError';
	}
}
export class ListenGenerateError extends Error {}

const CONCURRENCY = 3;
const CLIENT_RETRIES = 1;

interface GenerateResponseShape {
	document: { status: ListenStatus; doneCount: number; segmentCount: number };
	processed?: { seq: number; status: SegmentStatus; error?: string }[];
	error?: string;
}

export interface RunOptions {
	concurrency?: number;
	onSegmentChange?: (seq: number, status: SegmentStatus) => void;
	onProgress?: (done: number, total: number) => void;
	signal?: AbortSignal;
}

/**
 * Drive resumable per-segment generation. Fires up to N requests in parallel (each request
 * synthesizes one segment server-side, with its own retry budget). On failure, retries the
 * segment a few times client-side before giving up.
 */
export async function runGeneration(
	documentId: string,
	segments: { seq: number; status: SegmentStatus }[],
	options: RunOptions = {}
): Promise<void> {
	const total = segments.length;
	let done = segments.filter((s) => s.status === 'done').length;
	options.onProgress?.(done, total);

	const queue = segments
		.filter((s) => s.status !== 'done')
		.map((s) => s.seq)
		.sort((a, b) => a - b);
	if (!queue.length) return;

	let nextIndex = 0;
	let stopErr: Error | null = null;
	const concurrency = Math.max(1, Math.min(options.concurrency ?? CONCURRENCY, queue.length));

	async function processOne(seq: number): Promise<void> {
		options.onSegmentChange?.(seq, 'generating');
		let attempt = 0;
		for (;;) {
			if (options.signal?.aborted) throw new ListenGenerateError('aborted');
			const res = await fetch(`/api/listen/${documentId}/generate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ seq }),
				signal: options.signal
			});

			if (res.status === 400) {
				// Distinguish "missing key" (machine-readable error string) from validation errors.
				const data = (await res.json().catch(() => ({}))) as GenerateResponseShape;
				if (data.error?.includes('ElevenLabs API key')) throw new ListenKeyError();
				throw new ListenGenerateError(data.error || `bad request (${res.status})`);
			}
			if (!res.ok) throw new ListenGenerateError(`HTTP ${res.status}`);

			const data = (await res.json()) as GenerateResponseShape;
			const result = data.processed?.find((p) => p.seq === seq);
			if (!result || result.status === 'failed') {
				if (attempt < CLIENT_RETRIES) {
					attempt++;
					await new Promise((r) => setTimeout(r, 800 * attempt));
					continue;
				}
				options.onSegmentChange?.(seq, 'failed');
				throw new ListenGenerateError(result?.error || 'segment failed');
			}
			options.onSegmentChange?.(seq, 'done');
			done++;
			options.onProgress?.(done, total);
			return;
		}
	}

	async function worker(): Promise<void> {
		while (stopErr === null) {
			const idx = nextIndex++;
			if (idx >= queue.length) return;
			try {
				await processOne(queue[idx]);
			} catch (err) {
				stopErr = err instanceof Error ? err : new Error(String(err));
				return;
			}
		}
	}

	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	if (stopErr) throw stopErr;
}

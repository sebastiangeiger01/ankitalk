import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let audioContextConstructions = 0;

class FakeAudioBufferSourceNode {
	buffer: AudioBuffer | null = null;
	loop = false;
	onended: (() => void) | null = null;

	connect() {}
	disconnect() {}
	stop() {}
	start() {
		if (!this.loop) queueMicrotask(() => this.onended?.());
	}
}

class FakeAudioContext {
	state: AudioContextState = 'running';
	currentTime = 0;
	sampleRate = 44_100;
	destination = {} as AudioDestinationNode;

	constructor() {
		audioContextConstructions++;
	}

	createBuffer() {
		return {} as AudioBuffer;
	}

	createBufferSource() {
		return new FakeAudioBufferSourceNode() as unknown as AudioBufferSourceNode;
	}

	decodeAudioData() {
		return Promise.resolve({} as AudioBuffer);
	}

	resume() {
		this.state = 'running';
		return Promise.resolve();
	}
}

describe('review audio', () => {
	beforeEach(() => {
		vi.resetModules();
		audioContextConstructions = 0;
		vi.stubGlobal('AudioContext', FakeAudioContext);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('reuses an in-flight preload when the first card starts speaking', async () => {
		let resolveResponse!: (response: Response) => void;
		const response = new Promise<Response>((resolve) => {
			resolveResponse = resolve;
		});
		const fetchMock = vi.fn(() => response);
		vi.stubGlobal('fetch', fetchMock);

		const { preloadTTS, speak, unlockAudio } = await import('./audio');
		preloadTTS('first card');
		await Promise.resolve();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(audioContextConstructions).toBe(0);

		await unlockAudio();
		expect(audioContextConstructions).toBe(1);

		const playback = speak('first card');
		await Promise.resolve();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		resolveResponse(new Response(new Uint8Array([1]), { status: 200 }));
		await playback;
	});

	it('does not create an AudioContext while preloading before the Start gesture', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })));
		const { preloadTTS } = await import('./audio');

		preloadTTS('first card');

		expect(audioContextConstructions).toBe(0);
	});
});

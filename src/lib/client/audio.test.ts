import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let audioContextConstructions = 0;
let audioElementConstructions = 0;
let lastAudioElement: FakeAudioElement | null = null;
let rejectNextPlay = false;
let holdPlayback = false;

class FakeAudioElement {
	src = '';
	preload = '';
	playsInline = false;
	currentTime = 0;
	readyState = 4;
	networkState = 1;
	error: MediaError | null = null;
	pauseCalls = 0;
	playCalls = 0;
	private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

	constructor() {
		audioElementConstructions++;
		lastAudioElement = this;
	}

	load() {}
	canPlayType() {
		return 'probably';
	}
	pause() {
		this.pauseCalls++;
	}
	play() {
		this.playCalls++;
		if (rejectNextPlay) {
			rejectNextPlay = false;
			return Promise.reject(new DOMException('User gesture required', 'NotAllowedError'));
		}
		queueMicrotask(() => {
			this.dispatch('playing');
			// A real clip keeps playing (and ticking `timeupdate`) for a while before `ended`.
			// Tests that need to assert mid-playback state drive `ended` manually instead.
			if (!holdPlayback) this.dispatch('ended');
		});
		return Promise.resolve();
	}
	tick() {
		this.dispatch('timeupdate');
	}
	end() {
		this.dispatch('ended');
	}
	addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}
	removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
		this.listeners.get(type)?.delete(listener);
	}
	private dispatch(type: string) {
		const event = new Event(type);
		for (const listener of this.listeners.get(type) ?? []) {
			if (typeof listener === 'function') listener(event);
			else listener.handleEvent(event);
		}
	}
}

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
		audioElementConstructions = 0;
		lastAudioElement = null;
		rejectNextPlay = false;
		holdPlayback = false;
		vi.useRealTimers();
		vi.stubGlobal('AudioContext', FakeAudioContext);
		vi.stubGlobal('Audio', FakeAudioElement);
		vi.stubGlobal('URL', {
			createObjectURL: vi.fn(() => 'blob:tts-audio'),
			revokeObjectURL: vi.fn()
		});
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

		const { preloadTTS, speak } = await import('./audio');
		const preparation = preloadTTS('first card');
		await Promise.resolve();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(audioContextConstructions).toBe(0);
		expect(audioElementConstructions).toBe(0);

		resolveResponse(new Response(new Uint8Array([1]), { status: 200 }));
		expect(await preparation).toBe(true);

		const playbackStarted = vi.fn();
		const playback = speak('first card', undefined, undefined, playbackStarted);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(lastAudioElement?.playCalls).toBe(1);
		await playback;
		expect(audioElementConstructions).toBe(1);
		expect(audioContextConstructions).toBe(0);
		expect(playbackStarted).toHaveBeenCalledTimes(1);
		expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:tts-audio');
	});

	it('does not create an AudioContext while preloading before the Start gesture', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })));
		const { preloadTTS } = await import('./audio');

		preloadTTS('first card');

		expect(audioContextConstructions).toBe(0);
	});

	it('uses cache-only preloads and generates only when playback needs audio', async () => {
		const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? '{}')) as { generate?: boolean };
			if (body.generate === false) return new Response(null, { status: 204 });
			return new Response(new Uint8Array([1]), {
				status: 200,
				headers: { 'Content-Type': 'audio/mpeg' }
			});
		});
		vi.stubGlobal('fetch', fetchMock);
		const { preloadTTS, speak } = await import('./audio');

		await expect(preloadTTS('new card')).resolves.toBe(false);
		await speak('new card');

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ text: 'new card', generate: false });
		expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ text: 'new card', generate: true });
	});

	it('does not cut off a clip that plays longer than the start watchdog window', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
			status: 200,
			headers: { 'Content-Type': 'audio/mpeg' }
		})));
		const { preloadTTS, speak } = await import('./audio');
		expect(await preloadTTS('long card')).toBe(true);

		holdPlayback = true;
		const playback = speak('long card');
		await Promise.resolve();
		const player = lastAudioElement!;
		const basePause = player.pauseCalls;

		// Simulate ~30s of real playback with progress ticks well past the old 8s absolute cap.
		for (let elapsed = 0; elapsed < 30000; elapsed += 4000) {
			vi.advanceTimersByTime(4000);
			player.tick();
		}
		// Still playing, never rejected, never paused by a watchdog.
		expect(player.pauseCalls).toBe(basePause);

		player.end();
		await expect(playback).resolves.toBeUndefined();
	});

	it('rejects when a clip starts but then stalls with no progress', async () => {
		vi.useFakeTimers();
		vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
			status: 200,
			headers: { 'Content-Type': 'audio/mpeg' }
		})));
		const { preloadTTS, speak } = await import('./audio');
		expect(await preloadTTS('stalled card')).toBe(true);

		holdPlayback = true;
		const playback = speak('stalled card');
		const assertion = expect(playback).rejects.toThrow('TTS playback stalled');
		await Promise.resolve();

		// No `timeupdate` ticks: the stall watchdog should fire.
		vi.advanceTimersByTime(10000);
		await assertion;
	});

	it('reports Safari play rejections with actionable media diagnostics', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), {
			status: 200,
			headers: { 'Content-Type': 'audio/mpeg' }
		})));
		const { preloadTTS, speak } = await import('./audio');
		expect(await preloadTTS('first card')).toBe(true);
		rejectNextPlay = true;

		await expect(speak('first card')).rejects.toThrow(
			'TTS play() rejected: NotAllowedError: User gesture required (audio/mpeg, 1 bytes, canPlayType=probably; readyState=4, networkState=1)'
		);
	});
});

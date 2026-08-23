import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAudioSessionType, supportsAudioSession } from './audio-session';

afterEach(() => {
	vi.unstubAllGlobals();
});

function stubNavigator(session: unknown) {
	vi.stubGlobal('navigator', session === undefined ? {} : { audioSession: session });
}

describe('setAudioSessionType', () => {
	it('switches the session type and reports the previous one', () => {
		const session = { type: 'play-and-record' };
		stubNavigator(session);

		expect(setAudioSessionType('playback')).toBe('play-and-record');
		expect(session.type).toBe('playback');
	});

	it('is a no-op when the type already matches', () => {
		const session = { type: 'playback' };
		stubNavigator(session);

		expect(setAudioSessionType('playback')).toBe('playback');
		expect(session.type).toBe('playback');
	});

	it('does nothing on browsers without the API', () => {
		stubNavigator(undefined);

		expect(supportsAudioSession()).toBe(false);
		expect(setAudioSessionType('playback')).toBeNull();
	});

	it('swallows a setter that rejects the value', () => {
		stubNavigator({
			get type() {
				return 'auto';
			},
			set type(_value: string) {
				throw new TypeError('unsupported');
			}
		});

		expect(setAudioSessionType('playback')).toBeNull();
	});
});

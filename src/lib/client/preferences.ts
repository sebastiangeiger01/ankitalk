import { browser } from '$app/environment';

const PREPARE_AUDIO_KEY = 'ankitalk.prepareAudioAhead';

export const DEFAULT_PREPARE_AUDIO_AHEAD = true;

export function getPrepareAudioAhead(): boolean {
	if (!browser) return DEFAULT_PREPARE_AUDIO_AHEAD;
	return localStorage.getItem(PREPARE_AUDIO_KEY) !== '0';
}

export function setPrepareAudioAhead(enabled: boolean): void {
	if (!browser) return;
	localStorage.setItem(PREPARE_AUDIO_KEY, enabled ? '1' : '0');
	window.dispatchEvent(new CustomEvent('ankitalk:preferences-changed', {
		detail: { prepareAudioAhead: enabled }
	}));
}

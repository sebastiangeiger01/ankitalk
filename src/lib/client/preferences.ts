import { browser } from '$app/environment';

const PREPARE_AUDIO_KEY = 'ankitalk.prepareAudioAhead';
const PUSH_TO_TALK_KEY = 'ankitalk.pushToTalk';

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

/**
 * Push-to-talk for the tutor: when on, the mic stays muted unless the student holds the
 * talk button. Defaults on — it's the most reliable defence against the tutor hearing its
 * own voice on a phone speaker, and gives the student explicit control of the mic.
 */
export function getPushToTalk(): boolean {
	if (!browser) return true;
	return localStorage.getItem(PUSH_TO_TALK_KEY) !== '0';
}

export function setPushToTalk(enabled: boolean): void {
	if (!browser) return;
	localStorage.setItem(PUSH_TO_TALK_KEY, enabled ? '1' : '0');
}

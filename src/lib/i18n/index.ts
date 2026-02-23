import { writable, get } from 'svelte/store';
import { en } from './en';
import { de } from './de';

export type Locale = 'en' | 'de';

const locales: Record<Locale, Record<string, string>> = { en, de };

function detectLocale(): Locale {
	if (typeof window === 'undefined') return 'en';
	const saved = localStorage.getItem('locale');
	if (saved === 'en' || saved === 'de') return saved;
	return navigator.language.startsWith('de') ? 'de' : 'en';
}

export const locale = writable<Locale>(detectLocale());

locale.subscribe((val) => {
	if (typeof window !== 'undefined') {
		localStorage.setItem('locale', val);
	}
});

/**
 * Look up a translation key, interpolate {param} placeholders.
 * Falls back to English if key is missing in current locale.
 */
export function t(key: string, params?: Record<string, string | number>): string {
	const loc = get(locale);
	let str = locales[loc]?.[key] ?? locales.en[key] ?? key;
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
		}
	}
	return str;
}

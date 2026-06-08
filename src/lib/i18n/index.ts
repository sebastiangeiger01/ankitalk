import { derived, get, writable } from 'svelte/store';
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
		// Keep `<html lang>` in sync so screen readers pronounce content correctly.
		document.documentElement.lang = val;
	}
});

type Translator = (key: string, params?: Record<string, string | number>) => string;

function translateFor(loc: Locale): Translator {
	return (key, params) => {
		let str = locales[loc]?.[key] ?? locales.en[key] ?? key;
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
			}
		}
		return str;
	};
}

/**
 * Reactive translator. Consume in templates and `<script>` as `$t('key', { ... })` so the
 * markup re-renders automatically when the user switches language. Replaces the previous
 * non-reactive function, which forced every page to wrap its template in `{#key loc}` —
 * and in practice most pages forgot, so the nav, dashboard, review and both modals stayed
 * in the old language until reload.
 */
export const t = derived(locale, ($locale) => translateFor($locale));

/**
 * Non-reactive snapshot for the rare case where you need the current translation outside a
 * component (utility modules, fire-and-forget callbacks). Prefer `$t` in components.
 */
export function tNow(key: string, params?: Record<string, string | number>): string {
	return translateFor(get(locale))(key, params);
}

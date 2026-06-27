import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			routes: {
				include: ['/*'],
				exclude: ['<all>']
			},
			platformProxy: {
				configPath: 'wrangler.jsonc',
				persist: { path: '.wrangler/state' }
			}
		}),
		// SvelteKit's built-in CSRF check rejects ALL cross-origin form-content-type POSTs —
		// including the legitimate OAuth token exchange at `/api/mcp/oauth/token`, which is a
		// cross-origin `application/x-www-form-urlencoded` POST per OAuth 2.1 (and often arrives
		// with NO Origin header, since it's server-to-server; SvelteKit forbids those outright).
		// A scoped `trustedOrigins: ['https://claude.ai']` can't help — a missing Origin is always
		// rejected while the check is on — and the check has no per-route opt-out. So we turn it
		// off (`['*']` is the non-deprecated form of `checkOrigin: false`) and enforce an
		// equivalent, stricter same-origin guard ourselves in hooks.server.ts, which covers every
		// browser-driven mutation (API calls + page form actions) and exempts only the
		// bearer/PKCE-authenticated MCP/OAuth endpoints.
		csrf: { trustedOrigins: ['*'] }
	}
};

export default config;

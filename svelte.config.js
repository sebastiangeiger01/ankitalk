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
		// SvelteKit's built-in CSRF (`checkOrigin`) rejects ALL cross-origin form-content-type
		// POSTs, including legitimate ones to our OAuth `/api/mcp/oauth/token` endpoint — Claude
		// posts `application/x-www-form-urlencoded` from its own origin, which is exactly what
		// OAuth 2.1 requires. The check is global with no per-route opt-out, so we disable it and
		// enforce an equivalent same-origin guard ourselves in hooks.server.ts (which already
		// exempts the public MCP/OAuth endpoints and now also covers page form actions).
		csrf: { checkOrigin: false }
	}
};

export default config;

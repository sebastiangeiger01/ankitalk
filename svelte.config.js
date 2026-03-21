import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const platformProxyConfigPath = process.env.PLAYWRIGHT_TEST
	? 'wrangler.playwright.jsonc'
	: 'wrangler.jsonc';

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
				configPath: platformProxyConfigPath,
				persist: { path: '.wrangler/state' }
			}
		})
	}
};

export default config;

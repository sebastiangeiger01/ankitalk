import { sveltekit } from '@sveltejs/kit/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { defineConfig } from 'vite';
import { execSync } from 'child_process';

const commitHash = process.env.CF_PAGES_COMMIT_SHA?.slice(0, 7)
	|| (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; } })();

export default defineConfig({
	define: {
		__COMMIT_HASH__: JSON.stringify(commitHash)
	},
	plugins: [
		sveltekit(),
		viteStaticCopy({
			targets: [
				{
					src: 'node_modules/sql.js/dist/sql-wasm.wasm',
					dest: '.'
				},
				{
					src: 'node_modules/sql.js/dist/sql-wasm-browser.wasm',
					dest: '.'
				}
			]
		})
	]
});

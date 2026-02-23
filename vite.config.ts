import { sveltekit } from '@sveltejs/kit/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { defineConfig } from 'vite';

export default defineConfig({
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

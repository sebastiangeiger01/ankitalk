import { defineConfig, devices } from '@playwright/test';

const port = 4173;

export default defineConfig({
	testDir: './tests',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: 'html',
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: 'on-first-retry',
		locale: 'en-US',
	},
	webServer: {
		command: `npx svelte-kit sync && npm run dev -- --host 127.0.0.1 --port ${port}`,
		env: {
			...process.env,
			PLAYWRIGHT_TEST: '1',
		},
		url: `http://127.0.0.1:${port}`,
		reuseExistingServer: !process.env.CI,
		timeout: 120 * 1000,
	},
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
});

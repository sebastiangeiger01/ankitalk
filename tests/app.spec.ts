import { expect, test, type Page } from '@playwright/test';

type KeyStatus = {
	openai: boolean;
	deepgram: boolean;
	anthropic: boolean;
};

type UsageSummary = {
	today: { openai: number; deepgram: number; anthropic: number; total: number };
	week: { openai: number; deepgram: number; anthropic: number; total: number };
	month: { openai: number; deepgram: number; anthropic: number; total: number };
};

const emptyKeyStatus: KeyStatus = {
	openai: false,
	deepgram: false,
	anthropic: false,
};

const nonZeroUsage: UsageSummary = {
	today: { openai: 0.004, deepgram: 0.01, anthropic: 0, total: 0.014 },
	week: { openai: 0.02, deepgram: 0.04, anthropic: 0.03, total: 0.09 },
	month: { openai: 0.08, deepgram: 0.16, anthropic: 0.12, total: 0.36 },
};

async function mockKeyStatus(page: Page, status: KeyStatus = emptyKeyStatus) {
	await page.route('**/api/settings/api-keys', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(status),
		});
	});
}

async function mockUsage(page: Page, usage: UsageSummary) {
	await page.route('**/api/settings/usage', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(usage),
		});
	});
}

async function mockDecks(page: Page, decks: Array<Record<string, unknown>>) {
	await page.route('**/api/decks', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ decks }),
		});
	});
}

test('shows the dashboard onboarding flow when no decks are available', async ({ page }) => {
	await page.goto('/');

	await expect(page.getByRole('heading', { name: 'Your Decks' })).toBeVisible();
	await expect(page.getByRole('complementary', { name: 'Welcome to AnkiTalk!' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Welcome to AnkiTalk', exact: true })).toBeVisible();
	await expect(page.getByText('Review your Anki flashcards hands-free using voice commands.')).toBeVisible();
});

test('renders deck data returned by the dashboard API', async ({ page }) => {
	await mockKeyStatus(page, {
		openai: true,
		deepgram: true,
		anthropic: false,
	});
	await mockDecks(page, [
		{
			id: 'deck-spanish',
			name: 'Spanish Basics',
			card_count: 42,
			due_count: 7,
		},
	]);

	await page.goto('/');

	await expect(page.getByRole('heading', { name: 'Spanish Basics' })).toBeVisible();
	await expect(page.getByLabel('Spanish Basics deck, 42 cards, 7 due')).toBeVisible();
	await expect(page.getByText('7 due')).toBeVisible();
});

test('shows the empty usage state on the settings page when no activity is returned', async ({ page }) => {
	await page.addInitScript(() => {
		window.localStorage.setItem('locale', 'en');
	});
	await mockKeyStatus(page);
	await mockUsage(page, {
		today: { openai: 0, deepgram: 0, anthropic: 0, total: 0 },
		week: { openai: 0, deepgram: 0, anthropic: 0, total: 0 },
		month: { openai: 0, deepgram: 0, anthropic: 0, total: 0 },
	});

	await page.goto('/settings');

	await expect(page.getByRole('heading', { name: 'App Settings' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'API Keys' })).toBeVisible();
	await expect(page.getByText('No usage recorded yet')).toBeVisible();
	await expect(page.locator('.key-row')).toHaveCount(3);
	await expect(page.getByText('Not configured')).toHaveCount(3);
});

test('expands API key controls and shows the usage summary when data is available', async ({ page }) => {
	await page.addInitScript(() => {
		window.localStorage.setItem('locale', 'en');
	});
	await mockKeyStatus(page, {
		openai: true,
		deepgram: false,
		anthropic: false,
	});
	await mockUsage(page, nonZeroUsage);

	await page.goto('/settings');

	const openAiRow = page.locator('.key-row').filter({ hasText: 'OpenAI (Text-to-Speech)' });
	await expect(openAiRow.getByText('Configured')).toBeVisible();
	await expect(page.getByText('This week')).toBeVisible();
	await expect(page.getByText('This month')).toBeVisible();
	await expect(page.getByText('$0.09')).toBeVisible();

	const deepgramRow = page.locator('.key-row').filter({ hasText: 'Deepgram (Speech-to-Text)' });
	await deepgramRow.locator('button.action-btn').click();
	await expect(deepgramRow.getByPlaceholder('Paste your API key here')).toBeVisible();
	await expect(deepgramRow.getByRole('button', { name: 'Save' })).toBeDisabled();
});

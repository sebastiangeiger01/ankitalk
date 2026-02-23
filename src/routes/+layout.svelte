<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';
	import { locale, t } from '$lib/i18n';

	let { children, data }: { children: Snippet; data: LayoutData } = $props();
	let loc = $state('en');
	locale.subscribe((v) => { loc = v; });

	async function logout() {
		const { register } = await import('@teamhanko/hanko-elements');
		const { env } = await import('$env/dynamic/public');
		const { hanko } = await register(env.PUBLIC_HANKO_API_URL!);
		await hanko.user.logout();
		window.location.href = '/login';
	}
</script>

<svelte:head>
	<title>AnkiTalk</title>
</svelte:head>

{#if data.userId}
	<nav>
		<a href="/">{t('nav.title')}</a>
		<div class="nav-right">
			<a href="/settings" class="nav-icon" aria-label={t('nav.settings')} title={t('nav.settings')}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
			</a>
			<button onclick={logout}>{t('nav.logout')}</button>
		</div>
	</nav>
{/if}

<main>
	{@render children()}
</main>

<footer class="version">v{__COMMIT_HASH__}</footer>

<style>
	:global(body) {
		margin: 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
		background: #1a1a2e;
		color: #e0e0ff;
		min-height: 100dvh;
	}

	:global(*:focus-visible) {
		outline: 2px solid #6ecb63;
		outline-offset: 2px;
	}

	:global(*:focus:not(:focus-visible)) {
		outline: none;
	}

	nav {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 1.5rem;
		border-bottom: 1px solid #2a2a4e;
	}

	nav a {
		color: #e0e0ff;
		text-decoration: none;
		font-weight: 600;
		font-size: 1.1rem;
	}

	.nav-right {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.nav-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		color: #b0b0c0;
		padding: 0.3rem;
		border-radius: 6px;
		transition: color 0.15s;
	}

	.nav-icon:hover {
		color: #e0e0ff;
	}

	nav button {
		background: none;
		border: 1px solid #444;
		color: #b0b0c0;
		padding: 0.4rem 0.8rem;
		border-radius: 6px;
		cursor: pointer;
	}

	nav button:hover {
		border-color: #666;
		color: #ddd;
	}

	main {
		max-width: 800px;
		margin: 0 auto;
		padding: 1.5rem;
	}

	:global(body.review-active) main {
		max-width: none;
		padding: 0;
	}

	.version {
		position: fixed;
		bottom: 0.5rem;
		right: 0.75rem;
		font-size: 0.65rem;
		color: #555;
		pointer-events: none;
	}

	:global(body.review-active) nav,
	:global(body.review-active) .version {
		display: none;
	}
</style>

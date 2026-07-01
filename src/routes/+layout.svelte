<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';
	import { page } from '$app/stores';
	import { t } from '$lib/i18n';
	import '../app.css';

	let { children, data }: { children: Snippet; data: LayoutData } = $props();

	const isLearn = $derived(
		$page.url.pathname === '/' ||
			$page.url.pathname.startsWith('/decks') ||
			$page.url.pathname.startsWith('/review')
	);
	const isListen = $derived($page.url.pathname.startsWith('/listen'));
</script>

<svelte:head>
	<title>AnkiTalk</title>
</svelte:head>

{#if data.userId}
	<nav>
		<a href="/" class="brand">{$t('nav.title')}</a>
		<div class="nav-right">
			<a href="/" class="nav-tab" class:active={isLearn}>{$t('nav.learn')}</a>
			<a href="/listen" class="nav-tab" class:active={isListen}>{$t('nav.listen')}</a>
			<a href="/settings" class="nav-icon" aria-label={$t('nav.settings')} title={$t('nav.settings')}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
			</a>
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
		background: var(--bg);
		color: var(--text);
		min-height: 100dvh;
		overflow-x: hidden;
	}

	:global(*:focus-visible) {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	:global(*:focus:not(:focus-visible)) {
		outline: none;
	}

	nav {
		position: sticky;
		top: 0;
		z-index: 40;
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.75rem 1.5rem;
		padding-top: max(0.75rem, env(safe-area-inset-top));
		border-bottom: 1px solid var(--border-muted);
		background: rgba(10, 10, 10, 0.85);
		-webkit-backdrop-filter: blur(12px);
		backdrop-filter: blur(12px);
	}

	.brand {
		color: var(--text);
		text-decoration: none;
		font-weight: 600;
		font-size: 1.1rem;
		letter-spacing: -0.015em;
	}

	.nav-right {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.nav-tab {
		color: var(--text-muted);
		text-decoration: none;
		font-weight: 600;
		font-size: 0.9rem;
		white-space: nowrap;
		padding: 0.4rem 0.9rem;
		border-radius: var(--r-pill);
		transition: color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
	}

	.nav-tab:hover {
		color: var(--text);
	}

	.nav-tab.active {
		color: var(--text);
		background: var(--surface-elevated);
	}

	/* All nav targets sized to the WCAG 2.5.8 / Apple HIG 44px minimum tap target. */
	.nav-icon {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-muted);
		padding: 0.3rem;
		border-radius: var(--r-sm);
		transition: color var(--t-fast) var(--ease);
		min-width: 44px;
		min-height: 44px;
	}

	.nav-icon:hover {
		color: var(--text);
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
		color: var(--text-subtle);
		pointer-events: none;
	}

	:global(body.review-active) nav,
	:global(body.review-active) .version {
		display: none;
	}
</style>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { children, data }: { children: Snippet; data: LayoutData } = $props();

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
		<a href="/">AnkiTalk</a>
		<button onclick={logout}>Logout</button>
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

	.version {
		position: fixed;
		bottom: 0.5rem;
		right: 0.75rem;
		font-size: 0.65rem;
		color: #555;
		pointer-events: none;
	}
</style>

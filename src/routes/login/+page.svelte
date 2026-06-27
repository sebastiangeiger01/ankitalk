<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { env } from '$env/dynamic/public';
	import { t } from '$lib/i18n';

	let mounted = $state(false);

	/**
	 * Only follow a same-origin relative path (e.g. /oauth/authorize?...). Anything that could
	 * point off-site — an absolute URL or a protocol-relative `//host` — is ignored to prevent
	 * an open redirect through the login screen.
	 */
	function safeRedirect(value: string | null): string {
		if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
		return value;
	}

	onMount(() => {
		let cleanup: (() => void) | undefined;
		const dest = safeRedirect($page.url.searchParams.get('redirect'));

		import('@teamhanko/hanko-elements').then(async ({ register }) => {
			const { hanko } = await register(env.PUBLIC_HANKO_API_URL!);
			mounted = true;
			cleanup = hanko.onSessionCreated(() => {
				window.location.href = dest;
			});
		});

		return () => { cleanup?.(); };
	});
</script>

<div class="login-container">
	<h1>{$t('login.title')}</h1>
	<p class="subtitle">{$t('login.subtitle')}</p>

	{#if mounted}
		<hanko-auth></hanko-auth>
	{:else}
		<p>{$t('login.loading')}</p>
	{/if}
</div>

<style>
	.login-container {
		max-width: 400px;
		margin: 4rem auto;
		padding: 2rem;
		text-align: center;
	}

	h1 {
		font-size: 2rem;
		color: var(--text);
		margin-bottom: 0.25rem;
	}

	.subtitle {
		color: var(--text-muted);
		margin-bottom: 2rem;
	}
</style>

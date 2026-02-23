<script lang="ts">
	import { onMount } from 'svelte';
	import { env } from '$env/dynamic/public';
	import { t } from '$lib/i18n';

	let mounted = $state(false);

	onMount(() => {
		let cleanup: (() => void) | undefined;

		import('@teamhanko/hanko-elements').then(async ({ register }) => {
			const { hanko } = await register(env.PUBLIC_HANKO_API_URL!);
			mounted = true;
			cleanup = hanko.onSessionCreated(() => {
				window.location.href = '/';
			});
		});

		return () => { cleanup?.(); };
	});
</script>

<div class="login-container">
	<h1>{t('login.title')}</h1>
	<p class="subtitle">{t('login.subtitle')}</p>

	{#if mounted}
		<hanko-auth></hanko-auth>
	{:else}
		<p>{t('login.loading')}</p>
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
		color: #e0e0ff;
		margin-bottom: 0.25rem;
	}

	.subtitle {
		color: #a8a8b8;
		margin-bottom: 2rem;
	}
</style>

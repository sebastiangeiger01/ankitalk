<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { env } from '$env/dynamic/public';

	let mounted = $state(false);

	onMount(async () => {
		const { register } = await import('@teamhanko/hanko-elements');
		const { hanko } = await register(env.PUBLIC_HANKO_API_URL!);
		mounted = true;

		const cleanup = hanko.onSessionCreated(() => {
			window.location.href = '/';
		});

		return cleanup;
	});
</script>

<div class="login-container">
	<h1>AnkiTalk</h1>
	<p class="subtitle">Voice-powered flashcard reviews</p>

	{#if mounted}
		<hanko-auth></hanko-auth>
	{:else}
		<p>Loading...</p>
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

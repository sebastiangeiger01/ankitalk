<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { env } from '$env/dynamic/public';
	import { t } from '$lib/i18n';
	import Spinner from '$lib/components/Spinner.svelte';

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

	<div class="auth-card">
		{#if mounted}
			<hanko-auth></hanko-auth>
		{:else}
			<div class="auth-loading" role="status" aria-label={$t('login.loading')}>
				<Spinner size={28} />
			</div>
		{/if}
	</div>
</div>

<style>
	.login-container {
		max-width: 400px;
		margin: 4rem auto;
		padding: 0 1rem;
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

	.auth-card {
		background: var(--surface);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-lg);
		box-shadow: var(--shadow-md);
		padding: 1.75rem 1.5rem;
		text-align: left;
	}

	.auth-loading {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 200px;
		color: var(--text-muted);
	}

	/*
	 * Theme the Hanko web component. Its shadow DOM styles itself entirely from these CSS
	 * custom properties (names verified against @teamhanko/hanko-elements README "CSS
	 * Variables"), which inherit through the shadow boundary. Brand = white primary with the
	 * inverted dark contrast color; the surrounding card supplies background and padding.
	 */
	hanko-auth {
		--color: var(--text);
		--color-shade-1: var(--text-muted);
		--color-shade-2: var(--border-strong);

		--brand-color: var(--primary);
		--brand-color-shade-1: var(--primary-hover);
		--brand-contrast-color: var(--text-on-primary);

		--background-color: transparent;
		--error-color: var(--danger);
		--link-color: var(--text);

		--font-family: var(--font-sans);

		--border-radius: 10px;
		--item-height: 44px;

		--container-padding: 0;
		--container-max-width: 100%;
	}
</style>

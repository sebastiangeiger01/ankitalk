<script lang="ts">
	import { locale, t, type Locale } from '$lib/i18n';

	function setLocale(l: Locale) {
		locale.set(l);
	}

	let current = $state<Locale>('en');

	locale.subscribe((v) => { current = v; });
</script>

<div class="settings-page">
	<a href="/" class="back-link">&larr; {t('appSettings.dashboard')}</a>

	<h1>{t('appSettings.title')}</h1>

	<section class="section">
		<h2>{t('appSettings.language')}</h2>
		<div class="lang-options">
			<button class="lang-btn" class:active={current === 'en'} onclick={() => setLocale('en')}>
				English
			</button>
			<button class="lang-btn" class:active={current === 'de'} onclick={() => setLocale('de')}>
				Deutsch
			</button>
		</div>
	</section>
</div>

<style>
	.settings-page {
		max-width: 500px;
		margin: 0 auto;
		padding: 1rem;
	}

	.back-link {
		color: #a8a8b8;
		text-decoration: none;
		font-size: 0.9rem;
	}

	.back-link:hover {
		color: #e0e0ff;
	}

	h1 {
		margin: 1rem 0 1.5rem;
		font-size: 1.4rem;
	}

	.section h2 {
		font-size: 1rem;
		color: #b0b0d0;
		margin-bottom: 0.75rem;
	}

	.lang-options {
		display: flex;
		gap: 0.5rem;
	}

	.lang-btn {
		padding: 0.6rem 1.5rem;
		background: #22223a;
		border: 1px solid #3a3a5e;
		color: #a8a8b8;
		border-radius: 8px;
		cursor: pointer;
		font-size: 1rem;
		transition: all 0.15s;
	}

	.lang-btn:hover {
		border-color: #5a5a8e;
		color: #e0e0ff;
	}

	.lang-btn.active {
		background: #3a3a6e;
		border-color: #5a5a8e;
		color: #e0e0ff;
		font-weight: 600;
	}
</style>

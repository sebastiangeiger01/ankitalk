<script lang="ts">
	import { t } from '$lib/i18n';

	interface Props {
		hasRequiredKeys: boolean;
		hasDecks: boolean;
		hasReviewed: boolean;
		onDismiss: () => void;
	}

	let { hasRequiredKeys, hasDecks, hasReviewed, onDismiss }: Props = $props();

	// "Start review" is only meaningful once keys + deck are both ready
	let canStartReview = $derived(hasRequiredKeys && hasDecks);
</script>

<div class="checklist-card" role="complementary" aria-label={t('onboarding.title')}>
	<div class="checklist-header">
		<div class="checklist-titles">
			<h2>{t('onboarding.title')}</h2>
			<p class="subtitle">{t('onboarding.subtitle')}</p>
		</div>
		<button class="dismiss-btn" onclick={onDismiss} aria-label={t('onboarding.dismiss')} title={t('onboarding.dismiss')}>
			<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
				<path d="M3 3L13 13M13 3L3 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
			</svg>
		</button>
	</div>

	<ul class="steps">
		<!-- Step 1: Create account — always done -->
		<li class="step done">
			<span class="step-icon" aria-hidden="true">
				<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
					<circle cx="8" cy="8" r="7" fill="#6ecb63" stroke="#6ecb63"/>
					<path d="M4.5 8.5L7 11L11.5 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</span>
			<span class="step-label">{t('onboarding.createAccount')}</span>
		</li>

		<!-- Step 2: Add API keys -->
		<li class="step" class:done={hasRequiredKeys}>
			<span class="step-icon" aria-hidden="true">
				{#if hasRequiredKeys}
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="8" cy="8" r="7" fill="#6ecb63" stroke="#6ecb63"/>
						<path d="M4.5 8.5L7 11L11.5 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				{:else}
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="8" cy="8" r="7" stroke="#5a5a8e" stroke-width="1.5"/>
					</svg>
				{/if}
			</span>
			{#if hasRequiredKeys}
				<span class="step-label">{t('onboarding.addApiKeys')}</span>
			{:else}
				<a href="/settings" class="step-link">
					<span class="step-label">{t('onboarding.addApiKeys')}</span>
					<span class="step-desc">{t('onboarding.addApiKeysDesc')}</span>
				</a>
			{/if}
		</li>

		<!-- Step 3: Import a deck -->
		<li class="step" class:done={hasDecks}>
			<span class="step-icon" aria-hidden="true">
				{#if hasDecks}
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="8" cy="8" r="7" fill="#6ecb63" stroke="#6ecb63"/>
						<path d="M4.5 8.5L7 11L11.5 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				{:else}
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="8" cy="8" r="7" stroke="#5a5a8e" stroke-width="1.5"/>
					</svg>
				{/if}
			</span>
			{#if hasDecks}
				<span class="step-label">{t('onboarding.importDeck')}</span>
			{:else}
				<a href="/" class="step-link">
					<span class="step-label">{t('onboarding.importDeck')}</span>
				</a>
			{/if}
		</li>

		<!-- Step 4: Start first review -->
		<li class="step" class:done={hasReviewed} class:disabled={!canStartReview && !hasReviewed}>
			<span class="step-icon" aria-hidden="true">
				{#if hasReviewed}
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="8" cy="8" r="7" fill="#6ecb63" stroke="#6ecb63"/>
						<path d="M4.5 8.5L7 11L11.5 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				{:else}
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="8" cy="8" r="7" stroke="#5a5a8e" stroke-width="1.5"/>
					</svg>
				{/if}
			</span>
			{#if hasReviewed || !canStartReview}
				<span class="step-label">{t('onboarding.startReview')}</span>
			{:else}
				<a href="/" class="step-link">
					<span class="step-label">{t('onboarding.startReview')}</span>
				</a>
			{/if}
		</li>
	</ul>
</div>

<style>
	.checklist-card {
		background: #1e1e38;
		border: 1px solid #3a3a6e;
		border-radius: 12px;
		padding: 1.25rem 1.5rem;
		margin-bottom: 2rem;
		position: relative;
	}

	.checklist-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		margin-bottom: 1rem;
		gap: 0.5rem;
	}

	.checklist-titles {
		flex: 1;
		min-width: 0;
	}

	.checklist-titles h2 {
		margin: 0 0 0.2rem;
		font-size: 1rem;
		font-weight: 700;
		color: #e0e0ff;
	}

	.subtitle {
		margin: 0;
		font-size: 0.85rem;
		color: #9090b8;
	}

	.dismiss-btn {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		border: none;
		background: none;
		color: #6868a8;
		cursor: pointer;
		transition: background 0.15s, color 0.15s;
		margin-top: -2px;
	}

	.dismiss-btn:hover {
		background: #2a2a4e;
		color: #c0c0e0;
	}

	.steps {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.step {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-size: 0.9rem;
	}

	.step-icon {
		flex-shrink: 0;
		display: flex;
		align-items: center;
	}

	.step-label {
		color: #c8c8e8;
	}

	.step.done .step-label {
		color: #a0a0c8;
		text-decoration: line-through;
		text-decoration-color: #5a5a8e;
	}

	.step.disabled .step-label {
		color: #5a5a8e;
	}

	.step-link {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		text-decoration: none;
		color: inherit;
	}

	.step-link:hover .step-label {
		color: #e0e0ff;
		text-decoration: underline;
		text-decoration-color: #5a5aae;
	}

	.step-desc {
		font-size: 0.78rem;
		color: #6a6a9a;
	}
</style>

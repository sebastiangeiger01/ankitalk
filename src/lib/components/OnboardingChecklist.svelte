<script lang="ts">
	import { t } from '$lib/i18n';

	interface Props {
		hasRequiredKeys: boolean;
		hasDecks: boolean;
		hasReviewed: boolean;
		onDismiss: () => void;
		/** Triggers the dashboard's .apkg file picker so the import step is directly actionable. */
		onImport?: () => void;
	}

	let { hasRequiredKeys, hasDecks, hasReviewed, onDismiss, onImport }: Props = $props();

	// "Start review" is only meaningful once keys + deck are both ready
	let canStartReview = $derived(hasRequiredKeys && hasDecks);
</script>

<div class="checklist-card" role="complementary" aria-label={$t('onboarding.title')}>
	<div class="checklist-header">
		<div class="checklist-titles">
			<h2>{$t('onboarding.title')}</h2>
			<p class="subtitle">{$t('onboarding.subtitle')}</p>
		</div>
		<button class="dismiss-btn" onclick={onDismiss} aria-label={$t('onboarding.dismiss')} title={$t('onboarding.dismiss')}>
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
					<circle cx="8" cy="8" r="7" fill="var(--success)" stroke="var(--success)"/>
					<path d="M4.5 8.5L7 11L11.5 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			</span>
			<span class="step-label">{$t('onboarding.createAccount')}</span>
		</li>

		<!-- Step 2: Add API keys -->
		<li class="step" class:done={hasRequiredKeys}>
			<span class="step-icon" aria-hidden="true">
				{#if hasRequiredKeys}
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="8" cy="8" r="7" fill="var(--success)" stroke="var(--success)"/>
						<path d="M4.5 8.5L7 11L11.5 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				{:else}
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="8" cy="8" r="7" stroke="var(--border-strong)" stroke-width="1.5"/>
					</svg>
				{/if}
			</span>
			{#if hasRequiredKeys}
				<span class="step-label">{$t('onboarding.addApiKeys')}</span>
			{:else}
				<a href="/settings" class="step-link">
					<span class="step-label step-label--action">{$t('onboarding.addApiKeys')}</span>
					<span class="step-desc">{$t('onboarding.addApiKeysDesc')}</span>
					<span class="step-arrow" aria-hidden="true">&rsaquo;</span>
				</a>
			{/if}
		</li>

		<!-- Step 3: Import a deck -->
		<li class="step" class:done={hasDecks}>
			<span class="step-icon" aria-hidden="true">
				{#if hasDecks}
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="8" cy="8" r="7" fill="var(--success)" stroke="var(--success)"/>
						<path d="M4.5 8.5L7 11L11.5 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				{:else}
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="8" cy="8" r="7" stroke="var(--border-strong)" stroke-width="1.5"/>
					</svg>
				{/if}
			</span>
			{#if hasDecks || !onImport}
				<span class="step-label">{$t('onboarding.importDeck')}</span>
			{:else}
				<button type="button" class="step-link step-btn" onclick={onImport}>
					<span class="step-label step-label--action">{$t('onboarding.importDeck')}</span>
					<span class="step-arrow" aria-hidden="true">&rsaquo;</span>
				</button>
			{/if}
		</li>

		<!-- Step 4: Start first review -->
		<li class="step" class:done={hasReviewed} class:disabled={!canStartReview && !hasReviewed}>
			<span class="step-icon" aria-hidden="true">
				{#if hasReviewed}
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="8" cy="8" r="7" fill="var(--success)" stroke="var(--success)"/>
						<path d="M4.5 8.5L7 11L11.5 6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				{:else}
					<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
						<circle cx="8" cy="8" r="7" stroke="var(--border-strong)" stroke-width="1.5"/>
					</svg>
				{/if}
			</span>
			<span class="step-label">{$t('onboarding.startReview')}</span>
		</li>
	</ul>
</div>

<style>
	.checklist-card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--r-lg);
		box-shadow: var(--shadow-sm);
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
		color: var(--text);
	}

	.subtitle {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.dismiss-btn {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: var(--r-sm);
		border: none;
		background: none;
		color: var(--text-subtle);
		cursor: pointer;
		transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
		margin-top: -2px;
	}

	.dismiss-btn:hover {
		background: var(--surface-elevated);
		color: var(--text);
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
		color: var(--text);
	}

	.step-label--action {
		color: var(--text);
		text-decoration: underline;
		text-decoration-color: var(--border-strong);
		text-underline-offset: 2px;
	}

	.step.done .step-label {
		color: var(--text-subtle);
		text-decoration: line-through;
		text-decoration-color: var(--border-strong);
	}

	.step.disabled .step-label {
		color: var(--text-subtle);
	}

	.step-link {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		text-decoration: none;
		color: inherit;
		flex: 1;
		min-width: 0;
		padding: 0.3rem 0;
		-webkit-tap-highlight-color: rgba(255, 255, 255, 0.08);
	}

	.step-btn {
		background: none;
		border: none;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.step-link:hover .step-label--action,
	.step-link:active .step-label--action {
		text-decoration-color: var(--text);
	}

	.step-desc {
		font-size: 0.78rem;
		color: var(--text-subtle);
	}

	.step-arrow {
		margin-left: auto;
		font-size: 1.2rem;
		color: var(--border-strong);
		flex-shrink: 0;
	}

	.step-link:hover .step-arrow,
	.step-link:active .step-arrow {
		color: var(--text);
	}
</style>

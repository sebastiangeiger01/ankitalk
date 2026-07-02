<script lang="ts">
	import { t } from '$lib/i18n';
	import type { SavedFlagStatus } from '$lib/client/saved-flags.svelte';

	let { status }: { status?: SavedFlagStatus } = $props();
</script>

<!-- The wrapper is always rendered so the aria-live region exists before content arrives. -->
<span class="saved-flag" role="status" aria-live="polite">
	{#if status === 'saved'}
		<span class="saved-flag-ok">{$t('common.savedFlag')}</span>
	{:else if status === 'error'}
		<span class="saved-flag-err">{$t('common.saveFailedFlag')}</span>
	{/if}
</span>

<style>
	.saved-flag {
		display: inline-flex;
		align-items: center;
		font-size: 0.78rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.saved-flag-ok,
	.saved-flag-err {
		animation: fade-in var(--t-med) var(--ease);
	}

	.saved-flag-ok {
		color: var(--success);
	}

	.saved-flag-err {
		color: var(--danger-soft);
	}
</style>

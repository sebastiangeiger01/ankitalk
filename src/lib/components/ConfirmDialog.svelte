<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n';
	import { focusTrap } from '$lib/actions/focusTrap';

	interface Props {
		open: boolean;
		title: string;
		message?: string;
		/** Label for the action button; defaults to "Confirm". */
		confirmLabel?: string;
		/** Label for the cancel button; defaults to "Cancel". */
		cancelLabel?: string;
		/** Style the action button as destructive (red). */
		danger?: boolean;
		onconfirm: () => void;
		oncancel: () => void;
	}

	let { open, title, message, confirmLabel, cancelLabel, danger = false, onconfirm, oncancel }: Props = $props();

	let confirmBtn = $state<HTMLButtonElement | null>(null);

	// After mount put initial focus on the action button (not the cancel button) so Enter
	// confirms — the focusTrap action handles initial-focus too but it picks the first
	// focusable in DOM order, which here is Cancel. Override that to match user expectations.
	$effect(() => {
		if (open) tick().then(() => confirmBtn?.focus());
	});

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			oncancel();
		} else if (e.key === 'Enter' && document.activeElement === confirmBtn) {
			e.preventDefault();
			onconfirm();
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="backdrop"
		role="dialog"
		aria-modal="true"
		aria-label={title}
		tabindex="-1"
		onkeydown={onKey}
		use:focusTrap
	>
		<div class="modal">
			<h2>{title}</h2>
			{#if message}<p>{message}</p>{/if}
			<div class="actions">
				<button type="button" class="btn-secondary" onclick={oncancel}>
					{cancelLabel ?? $t('common.cancel')}
				</button>
				<button
					type="button"
					class={danger ? 'btn-danger' : 'btn-primary'}
					bind:this={confirmBtn}
					onclick={onconfirm}
				>
					{confirmLabel ?? $t('common.confirm')}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed; inset: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex; align-items: center; justify-content: center;
		z-index: 200; padding: 1rem;
	}
	.modal {
		background: var(--bg); border: 1px solid var(--border); border-radius: 12px;
		padding: 1.25rem; max-width: 420px; width: 100%;
	}
	h2 { font-size: 1.05rem; margin: 0 0 0.5rem; }
	p { color: var(--text-muted); font-size: 0.88rem; line-height: 1.45; margin: 0 0 1rem; white-space: pre-line; }
	.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: flex-end; }
	.btn-primary, .btn-secondary, .btn-danger {
		padding: 0.5rem 1rem; border-radius: 7px;
		font-size: 0.9rem; font-weight: 600; cursor: pointer; border: none;
	}
	.btn-primary { background: var(--primary); color: var(--text); }
	.btn-primary:hover { background: var(--primary-hover); }
	.btn-secondary { background: transparent; border: 1px solid var(--border); color: #c8c8e0; }
	.btn-secondary:hover { border-color: var(--border-strong); color: var(--text); }
	.btn-danger { background: var(--danger); color: #fff; }
	.btn-danger:hover { background: var(--danger-hover); }
</style>

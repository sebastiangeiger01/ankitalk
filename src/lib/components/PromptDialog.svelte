<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n';
	import { focusTrap } from '$lib/actions/focusTrap';

	interface Props {
		open: boolean;
		title: string;
		label?: string;
		initialValue?: string;
		placeholder?: string;
		/** Label for the action button; defaults to "Save". */
		saveLabel?: string;
		/** Label for the cancel button; defaults to "Cancel". */
		cancelLabel?: string;
		/** Error to show inline (e.g. validation: "title cannot be empty"). */
		errorMessage?: string;
		/** Called with the trimmed input. The parent decides whether to close or show an error. */
		onsave: (value: string) => void;
		oncancel: () => void;
	}

	let {
		open,
		title,
		label,
		initialValue = '',
		placeholder,
		saveLabel,
		cancelLabel,
		errorMessage,
		onsave,
		oncancel
	}: Props = $props();

	let value = $state('');
	let input = $state<HTMLInputElement | null>(null);

	// focusTrap handles focus restoration; we just need to pre-fill and select the input
	// (a generic first-focusable focus would land on Cancel, which isn't useful here).
	$effect(() => {
		if (open) {
			value = initialValue;
			tick().then(() => {
				input?.focus();
				input?.select();
			});
		}
	});

	function submit() {
		onsave(value.trim());
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			oncancel();
		} else if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
			e.preventDefault();
			submit();
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
			<label class="field">
				{#if label}<span class="field-label">{label}</span>{/if}
				<input
					type="text"
					bind:value
					bind:this={input}
					placeholder={placeholder ?? ''}
					aria-invalid={errorMessage ? 'true' : 'false'}
				/>
			</label>
			{#if errorMessage}<p class="error">{errorMessage}</p>{/if}
			<div class="actions">
				<button type="button" class="btn-secondary" onclick={oncancel}>
					{cancelLabel ?? $t('common.cancel')}
				</button>
				<button type="button" class="btn-primary" onclick={submit}>
					{saveLabel ?? $t('common.save')}
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
		padding: 1.25rem; max-width: 440px; width: 100%;
	}
	h2 { font-size: 1.05rem; margin: 0 0 0.75rem; }
	.field { display: block; margin-bottom: 0.75rem; }
	.field-label { display: block; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.3rem; font-weight: 600; }
	input {
		width: 100%; box-sizing: border-box;
		padding: 0.55rem 0.7rem; border-radius: 7px;
		background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
		font-size: 0.95rem; font-family: inherit;
	}
	input:focus { outline: none; border-color: var(--border-strong); }
	input[aria-invalid='true'] { border-color: var(--danger-hover); }
	.error { color: var(--danger-soft); font-size: 0.82rem; margin: 0 0 0.75rem; }
	.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: flex-end; }
	.btn-primary, .btn-secondary {
		padding: 0.5rem 1rem; border-radius: 7px;
		font-size: 0.9rem; font-weight: 600; cursor: pointer; border: none;
	}
	.btn-primary { background: var(--primary); color: var(--text); }
	.btn-primary:hover { background: var(--primary-hover); }
	.btn-secondary { background: transparent; border: 1px solid var(--border); color: #c8c8e0; }
	.btn-secondary:hover { border-color: var(--border-strong); color: var(--text); }
</style>

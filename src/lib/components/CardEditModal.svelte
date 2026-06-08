<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n';
	import type { NoteField } from '$lib/types';

	interface Props {
		open: boolean;
		deckId: string;
		cardId?: string;
		initialFields?: NoteField[];
		initialTags?: string;
		createMode?: boolean;
		onclose: () => void;
		onsave: () => void;
	}

	let { open, deckId, cardId, initialFields, initialTags, createMode = false, onclose, onsave }: Props = $props();

	let fields = $state<NoteField[]>([]);
	let tags = $state('');
	let cardType = $state<'basic' | 'cloze'>('basic');
	let saving = $state(false);
	let errorMsg = $state('');

	let modalEl = $state<HTMLDivElement | null>(null);
	let previouslyFocused: HTMLElement | null = null;

	$effect(() => {
		if (open) {
			fields = initialFields ? initialFields.map((f) => ({ ...f })) : [{ name: 'Front', value: '' }, { name: 'Back', value: '' }];
			tags = initialTags ?? '';
			cardType = 'basic';
			saving = false;
			errorMsg = '';
			previouslyFocused = document.activeElement as HTMLElement | null;
			tick().then(() => modalEl?.querySelector<HTMLTextAreaElement>('textarea')?.focus());
		} else if (previouslyFocused) {
			previouslyFocused.focus();
			previouslyFocused = null;
		}
	});

	async function handleSave() {
		if (fields.every((f) => !f.value.trim())) {
			errorMsg = $t('cards.editor.emptyError');
			return;
		}

		saving = true;
		errorMsg = '';

		try {
			if (createMode) {
				const res = await fetch(`/api/decks/${deckId}/cards`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ fields, tags, cardType })
				});
				if (!res.ok) throw new Error($t('cards.editor.createFailed'));
			} else if (cardId) {
				const res = await fetch(`/api/cards/${cardId}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ fields, tags })
				});
				if (!res.ok) throw new Error($t('cards.editor.updateFailed'));
			}
			onsave();
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : $t('cards.editor.saveFailed');
		} finally {
			saving = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="backdrop"
		role="dialog"
		aria-modal="true"
		aria-label={createMode ? $t('cards.editor.createAriaLabel') : $t('cards.editor.editAriaLabel')}
		tabindex="-1"
		onkeydown={handleKeydown}
	>
		<div class="modal" bind:this={modalEl}>
			<h2>{createMode ? $t('cards.editor.new') : $t('cards.editor.edit')}</h2>

			{#each fields as field, i}
				<label class="field-label">
					{field.name}
					<textarea
						bind:value={fields[i].value}
						rows="3"
						placeholder="{field.name}..."
					></textarea>
				</label>
			{/each}

			<label class="field-label">
				{$t('cards.editor.tags')}
				<input type="text" bind:value={tags} placeholder={$t('cards.editor.tagsPlaceholder')} />
			</label>

			{#if createMode}
				<label class="field-label">
					{$t('cards.editor.cardType')}
					<select bind:value={cardType}>
						<option value="basic">{$t('cards.editor.cardTypeBasic')}</option>
						<option value="cloze">{$t('cards.editor.cardTypeCloze')}</option>
					</select>
				</label>
			{/if}

			{#if errorMsg}
				<p class="error">{errorMsg}</p>
			{/if}

			<div class="actions">
				<button type="button" class="btn-secondary" onclick={onclose} disabled={saving}>
					{$t('common.cancel')}
				</button>
				<button type="button" class="btn-primary" onclick={handleSave} disabled={saving}>
					{saving ? $t('common.saving') : $t('common.save')}
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
		z-index: 100; padding: 1rem;
	}
	.modal {
		background: var(--bg); border: 1px solid var(--border); border-radius: 12px;
		padding: 1.5rem; width: 100%; max-width: 500px; max-height: 80vh; overflow-y: auto;
	}
	h2 { margin: 0 0 1rem; font-size: 1.2rem; }
	.field-label {
		display: block; margin-bottom: 1rem;
		font-size: 0.85rem; color: var(--text-muted); font-weight: 600;
	}
	textarea, input, select {
		display: block; width: 100%; box-sizing: border-box;
		margin-top: 0.3rem; padding: 0.6rem;
		/* Aligned with the rest of the app's form inputs (var(--surface-2)), not the prior var(--surface). */
		background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px;
		color: var(--text); font-size: 0.9rem; font-family: inherit; resize: vertical;
	}
	textarea:focus, input:focus, select:focus { outline: none; border-color: var(--border-strong); }
	.error { color: var(--danger-soft); font-size: 0.85rem; margin: 0.5rem 0; }
	.actions { display: flex; gap: 0.75rem; justify-content: flex-end; margin-top: 1rem; }
	.btn-primary, .btn-secondary {
		padding: 0.5rem 1.2rem; border-radius: 7px;
		font-size: 0.9rem; font-weight: 600; cursor: pointer; border: none;
	}
	.btn-primary { background: var(--primary); color: var(--text); }
	.btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
	.btn-secondary { background: transparent; border: 1px solid var(--border); color: #c8c8e0; }
	.btn-secondary:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text); }
	.btn-primary:disabled, .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>

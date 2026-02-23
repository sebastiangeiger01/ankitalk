<script lang="ts">
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

	$effect(() => {
		if (open) {
			fields = initialFields ? initialFields.map((f) => ({ ...f })) : [{ name: 'Front', value: '' }, { name: 'Back', value: '' }];
			tags = initialTags ?? '';
			cardType = 'basic';
			saving = false;
			errorMsg = '';
		}
	});

	async function handleSave() {
		if (fields.every((f) => !f.value.trim())) {
			errorMsg = 'At least one field must have content';
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
				if (!res.ok) throw new Error('Failed to create card');
			} else if (cardId) {
				const res = await fetch(`/api/cards/${cardId}`, {
					method: 'PUT',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ fields, tags })
				});
				if (!res.ok) throw new Error('Failed to update card');
			}
			onsave();
		} catch (err) {
			errorMsg = err instanceof Error ? err.message : 'Save failed';
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
	<div class="overlay" role="dialog" aria-modal="true" aria-label={createMode ? 'Create card' : 'Edit card'} tabindex="-1" onkeydown={handleKeydown}>
		<div class="modal">
			<h2>{createMode ? 'New Card' : 'Edit Card'}</h2>

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
				Tags
				<input type="text" bind:value={tags} placeholder="tag1 tag2 tag3" />
			</label>

			{#if createMode}
				<label class="field-label">
					Card Type
					<select bind:value={cardType}>
						<option value="basic">Basic</option>
						<option value="cloze">Cloze</option>
					</select>
				</label>
			{/if}

			{#if errorMsg}
				<p class="error">{errorMsg}</p>
			{/if}

			<div class="actions">
				<button class="cancel-btn" onclick={onclose} disabled={saving}>Cancel</button>
				<button class="save-btn" onclick={handleSave} disabled={saving}>
					{saving ? 'Saving...' : 'Save'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
		padding: 1rem;
	}

	.modal {
		background: #1a1a2e;
		border: 1px solid #3a3a5e;
		border-radius: 12px;
		padding: 1.5rem;
		width: 100%;
		max-width: 500px;
		max-height: 80vh;
		overflow-y: auto;
	}

	h2 {
		margin: 0 0 1rem;
		font-size: 1.2rem;
	}

	.field-label {
		display: block;
		margin-bottom: 1rem;
		font-size: 0.85rem;
		color: #a8a8b8;
		font-weight: 600;
	}

	textarea, input, select {
		display: block;
		width: 100%;
		margin-top: 0.3rem;
		padding: 0.6rem;
		background: #22223a;
		border: 1px solid #3a3a5e;
		border-radius: 6px;
		color: #e0e0ff;
		font-size: 0.9rem;
		font-family: inherit;
		resize: vertical;
	}

	textarea:focus, input:focus, select:focus {
		outline: none;
		border-color: #5a5a8e;
	}

	.error {
		color: #ff6666;
		font-size: 0.85rem;
		margin: 0.5rem 0;
	}

	.actions {
		display: flex;
		gap: 0.75rem;
		justify-content: flex-end;
		margin-top: 1rem;
	}

	.cancel-btn {
		padding: 0.5rem 1.2rem;
		background: none;
		border: 1px solid #444;
		color: #a8a8b8;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.9rem;
	}

	.cancel-btn:hover {
		border-color: #666;
		color: #ddd;
	}

	.save-btn {
		padding: 0.5rem 1.2rem;
		background: #4a4a8e;
		border: none;
		color: #e0e0ff;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.9rem;
		font-weight: 600;
	}

	.save-btn:hover {
		background: #5a5aae;
	}

	.save-btn:disabled, .cancel-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>

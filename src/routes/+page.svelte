<script lang="ts">
	import { parseApkg } from '$lib/client/anki-parser';
	import type { DeckWithDueCount } from '$lib/types';

	let decks = $state<DeckWithDueCount[]>([]);
	let importing = $state(false);
	let importStatus = $state('');
	let loading = $state(true);

	async function loadDecks() {
		const res = await fetch('/api/decks');
		if (res.ok) {
			const data = (await res.json()) as { decks: DeckWithDueCount[] };
			decks = data.decks;
		}
		loading = false;
	}

	async function handleFileUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;

		importing = true;
		importStatus = 'Parsing .apkg file...';

		try {
			const parsed = await parseApkg(file);
			importStatus = `Found ${parsed.cards.length} cards in ${parsed.decks.length} deck(s). Uploading...`;

			const formData = new FormData();
			formData.append(
				'data',
				JSON.stringify({
					decks: parsed.decks,
					notes: parsed.notes,
					cards: parsed.cards
				})
			);

			// Append media files
			for (const [filename, blob] of parsed.media) {
				formData.append(`media-${filename}`, blob, filename);
			}

			const res = await fetch('/api/cards/import', {
				method: 'POST',
				body: formData
			});

			if (!res.ok) {
				throw new Error(`Import failed: ${res.status}`);
			}

			const result = (await res.json()) as { cardCount: number; mediaCount: number };
			importStatus = `Imported ${result.cardCount} cards, ${result.mediaCount} media files.`;

			await loadDecks();
		} catch (err) {
			importStatus = `Error: ${err instanceof Error ? err.message : 'Import failed'}`;
		} finally {
			importing = false;
			input.value = '';
		}
	}

	async function deleteDeck(deckId: string, deckName: string) {
		if (!confirm(`Delete "${deckName}" and all its cards?`)) return;

		const res = await fetch(`/api/decks/${deckId}`, { method: 'DELETE' });
		if (res.ok) {
			await loadDecks();
		}
	}

	// Load decks on mount
	$effect(() => {
		loadDecks();
	});
</script>

<h1>Your Decks</h1>

<section class="upload">
	<label class="upload-btn" class:disabled={importing}>
		{importing ? 'Importing...' : 'Import .apkg File'}
		<input type="file" accept=".apkg" onchange={handleFileUpload} disabled={importing} hidden />
	</label>
	{#if importStatus}
		<p class="status">{importStatus}</p>
	{/if}
</section>

{#if loading}
	<p class="loading">Loading decks...</p>
{:else if decks.length === 0}
	<p class="empty">No decks yet. Import an .apkg file from Anki to get started.</p>
{:else}
	<ul class="deck-list">
		{#each decks as deck (deck.id)}
			<li class="deck-card">
				<a href="/review/{deck.id}" class="deck-link">
					<h2>{deck.name}</h2>
					<div class="deck-stats">
						<span>{deck.card_count} cards</span>
						<span class="due" class:has-due={deck.due_count > 0}>
							{deck.due_count} due
						</span>
					</div>
				</a>
				<button class="delete-btn" onclick={() => deleteDeck(deck.id, deck.name)}>
					Delete
				</button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	h1 {
		margin-bottom: 1.5rem;
	}

	.upload {
		margin-bottom: 2rem;
	}

	.upload-btn {
		display: inline-block;
		padding: 0.75rem 1.5rem;
		background: #3a3a6e;
		color: #e0e0ff;
		border-radius: 8px;
		cursor: pointer;
		font-size: 1rem;
		transition: background 0.2s;
	}

	.upload-btn:hover {
		background: #4a4a8e;
	}

	.upload-btn.disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.status {
		margin-top: 0.75rem;
		color: #aaa;
		font-size: 0.9rem;
	}

	.loading,
	.empty {
		color: #888;
	}

	.deck-list {
		list-style: none;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.deck-card {
		display: flex;
		align-items: center;
		background: #22223a;
		border-radius: 10px;
		overflow: hidden;
	}

	.deck-link {
		flex: 1;
		padding: 1rem 1.25rem;
		color: inherit;
		text-decoration: none;
	}

	.deck-link:hover {
		background: #2a2a4e;
	}

	.deck-link h2 {
		margin: 0 0 0.3rem;
		font-size: 1.1rem;
	}

	.deck-stats {
		display: flex;
		gap: 1rem;
		font-size: 0.85rem;
		color: #888;
	}

	.due.has-due {
		color: #6ecb63;
		font-weight: 600;
	}

	.delete-btn {
		padding: 0.5rem 1rem;
		margin-right: 0.75rem;
		background: none;
		border: 1px solid #444;
		color: #888;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8rem;
	}

	.delete-btn:hover {
		border-color: #e53e3e;
		color: #e53e3e;
	}
</style>

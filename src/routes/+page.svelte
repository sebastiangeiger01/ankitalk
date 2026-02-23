<script lang="ts">
	import { parseApkg } from '$lib/client/anki-parser';
	import { buildApkg } from '$lib/client/apkg-export';
	import { locale, t } from '$lib/i18n';
	import type { DeckWithDueCount } from '$lib/types';

	let decks = $state<DeckWithDueCount[]>([]);
	let importing = $state(false);
	let importStatus = $state('');
	let loading = $state(true);
	let loc = $state('en');
	locale.subscribe((v) => { loc = v; });

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
		importStatus = t('import.parsing');

		try {
			const parsed = await parseApkg(file);
			importStatus = t('import.found', { cards: parsed.cards.length, decks: parsed.decks.length });

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
			importStatus = t('import.done', { cards: result.cardCount, media: result.mediaCount });

			await loadDecks();
		} catch (err) {
			importStatus = t('import.error', { message: err instanceof Error ? err.message : 'Import failed' });
		} finally {
			importing = false;
			input.value = '';
		}
	}

	let exportingDeckId = $state('');

	async function exportDeck(deckId: string, deckName: string) {
		exportingDeckId = deckId;
		try {
			const res = await fetch(`/api/decks/${deckId}/export-data`);
			if (!res.ok) throw new Error('Failed to fetch deck data');
			const data = (await res.json()) as { deck: Record<string, unknown>; notes: Record<string, unknown>[]; cards: Record<string, unknown>[] };

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const apkg = await buildApkg(data.deck as any, data.notes as any, data.cards as any);

			const blob = new Blob([apkg.buffer as ArrayBuffer], { type: 'application/octet-stream' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${deckName.replace(/[^a-zA-Z0-9]/g, '_')}.apkg`;
			a.click();
			URL.revokeObjectURL(url);
		} catch (err) {
			alert(t('dashboard.exportFailed', { error: err instanceof Error ? err.message : 'Unknown error' }));
		} finally {
			exportingDeckId = '';
		}
	}

	async function deleteDeck(deckId: string, deckName: string) {
		if (!confirm(t('dashboard.deleteConfirm', { name: deckName }))) return;

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

<h1>{t('dashboard.title')}</h1>

<section class="upload">
	<label class="upload-btn" class:disabled={importing} aria-label={importing ? t('dashboard.importing') : t('dashboard.import')}>
		{importing ? t('dashboard.importing') : t('dashboard.import')}
		<input type="file" accept=".apkg" onchange={handleFileUpload} disabled={importing} hidden />
	</label>
	{#if importStatus}
		<p class="status">{importStatus}</p>
	{/if}
</section>

{#if loading}
	<p class="loading">{t('dashboard.loading')}</p>
{:else if decks.length === 0}
	<div class="onboarding">
		<div class="onboarding-icon">
			<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
				<rect x="8" y="12" width="48" height="40" rx="6" stroke="#4a4a8e" stroke-width="2.5" fill="none"/>
				<path d="M24 32 L30 38 L40 26" stroke="#6ecb63" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
				<circle cx="48" cy="16" r="8" fill="#4a4a8e"/>
				<path d="M48 12 L48 20 M44 16 L52 16" stroke="#e0e0ff" stroke-width="2" stroke-linecap="round"/>
			</svg>
		</div>
		<h2>{t('onboarding.welcome')}</h2>
		<p class="onboarding-desc">{t('onboarding.desc')}</p>
		<p class="onboarding-steps">{@html t('onboarding.steps')}</p>
		<label class="upload-btn primary-cta" class:disabled={importing} aria-label={importing ? t('dashboard.importing') : t('dashboard.import')}>
			{importing ? t('dashboard.importing') : t('dashboard.import')}
			<input type="file" accept=".apkg" onchange={handleFileUpload} disabled={importing} hidden />
		</label>
	</div>
{:else}
	<ul class="deck-list">
		{#each decks as deck (deck.id)}
			<li class="deck-card" aria-label="{deck.name} deck, {deck.card_count} cards, {deck.due_count} due">
				<a href="/review/{deck.id}" class="deck-link">
					<h2>{deck.name}</h2>
					<div class="deck-stats">
						<span>{t('dashboard.cards', { count: deck.card_count })}</span>
						<span class="due" class:has-due={deck.due_count > 0}>
							{t('dashboard.due', { count: deck.due_count })}
						</span>
					</div>
				</a>
				<div class="deck-actions">
					<a href="/decks/{deck.id}/cards" class="deck-action-btn" aria-label="{t('dashboard.browse')} {deck.name}" title={t('dashboard.browse')}>📇</a>
					<button class="deck-action-btn" aria-label="{t('dashboard.export')} {deck.name}" title={t('dashboard.export')} disabled={exportingDeckId === deck.id} onclick={() => exportDeck(deck.id, deck.name)}>
						{exportingDeckId === deck.id ? '⏳' : '📤'}
					</button>
					<a href="/decks/{deck.id}/settings" class="deck-action-btn" aria-label="{t('dashboard.settings')} {deck.name}" title={t('dashboard.settings')}>⚙️</a>
					<a href="/decks/{deck.id}/stats" class="deck-action-btn" aria-label="{t('dashboard.stats')} {deck.name}" title={t('dashboard.stats')}>📊</a>
					<button class="deck-action-btn delete" aria-label="{t('dashboard.delete')} {deck.name}" title={t('dashboard.delete')} onclick={() => deleteDeck(deck.id, deck.name)}>🗑️</button>
				</div>
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

	.loading {
		color: #a8a8b8;
	}

	.onboarding {
		text-align: center;
		padding: 3rem 1rem;
		max-width: 420px;
		margin: 0 auto;
	}

	.onboarding-icon {
		margin-bottom: 1.5rem;
	}

	.onboarding h2 {
		margin: 0 0 0.75rem;
	}

	.onboarding-desc {
		color: #b0b0c0;
		font-size: 0.95rem;
		line-height: 1.5;
		margin-bottom: 1rem;
	}

	.onboarding-steps {
		color: #a8a8b8;
		font-size: 0.85rem;
		line-height: 1.5;
		margin-bottom: 1.5rem;
	}

	.primary-cta {
		padding: 0.9rem 2rem !important;
		font-size: 1.1rem !important;
		background: #4a4a8e !important;
	}

	.primary-cta:hover {
		background: #5a5aae !important;
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
		flex-wrap: wrap;
	}

	.deck-link {
		flex: 1;
		padding: 1rem 1.25rem;
		color: inherit;
		text-decoration: none;
		min-width: 0;
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
		color: #a8a8b8;
	}

	.due.has-due {
		color: #6ecb63;
		font-weight: 600;
	}

	.deck-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		padding: 0 0.5rem;
	}

	@media (max-width: 600px) {
		.deck-card {
			flex-direction: column;
			align-items: stretch;
		}

		.deck-link {
			padding: 0.75rem 1rem;
		}

		.deck-actions {
			padding: 0 1rem 0.75rem;
			gap: 0.25rem;
		}
	}

	.deck-action-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: 6px;
		border: none;
		background: none;
		cursor: pointer;
		font-size: 1.1rem;
		text-decoration: none;
		transition: background 0.15s;
	}

	.deck-action-btn:hover {
		background: #2a2a4e;
	}

	.deck-action-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.deck-action-btn.delete:hover {
		background: #3a1515;
	}
</style>

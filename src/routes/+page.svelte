<script lang="ts">
	import { browser } from '$app/environment';
	import { parseApkg } from '$lib/client/anki-parser';
	import { buildApkg } from '$lib/client/apkg-export';
	import OnboardingChecklist from '$lib/components/OnboardingChecklist.svelte';
	import { locale, t } from '$lib/i18n';
	import { preloadTTS } from '$lib/client/audio';
	import type { DeckWithDueCount } from '$lib/types';

	let decks = $state<DeckWithDueCount[]>([]);
	let importing = $state(false);
	let importStatus = $state('');
	let loading = $state(true);
	let loc = $state('en');
	locale.subscribe((v) => { loc = v; });

	// Onboarding state
	let hasRequiredKeys = $state(false);
	let hasReviewed = $state(false);
	let onboardingDismissed = $state(browser && document.cookie.includes('onboarding_dismissed=1'));

	let showOnboarding = $derived(
		!onboardingDismissed && !(hasRequiredKeys && decks.length > 0 && hasReviewed)
	);

	function dismissOnboarding() {
		onboardingDismissed = true;
		document.cookie = 'onboarding_dismissed=1; path=/; max-age=31536000';
	}

	async function loadDecks() {
		const res = await fetch('/api/decks');
		if (res.ok) {
			const data = (await res.json()) as { decks: DeckWithDueCount[] };
			decks = data.decks;
			// Warm up TTS cache for the first due card of each deck with cards due.
			// Limited to 3 decks to avoid hammering the TTS endpoint on large collections.
			// The audioCache is module-level so these buffers are already decoded when
			// the user navigates to the review page.
			prefetchDueDecksTTS(data.decks);
		}
		loading = false;
	}

	function prefetchDueDecksTTS(allDecks: DeckWithDueCount[]) {
		const targets = allDecks.filter((d) => d.due_count > 0).slice(0, 3);
		for (const deck of targets) {
			fetch(`/api/cards/next?${new URLSearchParams({ deckId: deck.id, limit: '1' })}`)
				.then((r) => r.ok ? r.json() : null)
				.then((data: { cards: { fields: string; card_type: string }[] } | null) => {
					const card = data?.cards?.[0];
					if (!card) return;
					const fields = JSON.parse(card.fields) as { value: string }[];
					if (!fields.length) return;
					const firstValue = fields[0]?.value ?? '';
					const isCloze = card.card_type === 'cloze' || /\{\{c\d+::/.test(firstValue);
					const rawHtml = isCloze
						? firstValue.replace(/\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g, (_m, _a, hint) => hint || 'blank')
						: firstValue;
					const div = document.createElement('div');
					div.innerHTML = rawHtml;
					const plain = (div.textContent ?? '').trim();
					if (plain) preloadTTS(plain);
				})
				.catch(() => {});
		}
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

	// Load decks and onboarding state on mount
	$effect(() => {
		loadDecks();
		// Fetch key status for onboarding
		fetch('/api/settings/api-keys').then(r => r.ok ? r.json() : null).then((data) => {
			if (data) hasRequiredKeys = data.openai && data.deepgram;
		}).catch(() => {});
		// Check if user has any reviews (simple heuristic: check first deck's stats or use a lightweight query)
		// For now, we'll consider "has reviewed" once they have decks with any due history
		// This is a lightweight check via the decks endpoint — if any deck has reps > 0
	});
</script>

<h1>{t('dashboard.title')}</h1>

{#if showOnboarding && !loading}
	<OnboardingChecklist
		{hasRequiredKeys}
		hasDecks={decks.length > 0}
		{hasReviewed}
		onDismiss={dismissOnboarding}
	/>
{/if}

<section class="upload">
	<label class="upload-btn" class:disabled={importing} aria-label={importing ? t('dashboard.importing') : t('dashboard.import')}>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
		{importing ? t('dashboard.importing') : t('dashboard.import')}
		<input type="file" accept=".apkg" onchange={handleFileUpload} disabled={importing} hidden />
	</label>
	{#if importStatus}
		<p class="status">{importStatus}</p>
	{/if}
</section>

{#if loading}
	<ul class="deck-list" aria-hidden="true">
		{#each [1, 2, 3] as _}
			<li class="deck-card">
				<div class="skeleton-body">
					<div class="skeleton-title"></div>
					<div class="skeleton-meta"></div>
				</div>
			</li>
		{/each}
	</ul>
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
			<li class="deck-card" class:has-due={deck.due_count > 0} aria-label="{deck.name} deck, {deck.card_count} cards, {deck.due_count} due">
				<a href="/review/{deck.id}" class="deck-link">
					<h2>{deck.name}</h2>
					<div class="deck-stats">
						<span>{t('dashboard.cards', { count: deck.card_count })}</span>
						{#if deck.due_count > 0}
							<span class="due-badge">{t('dashboard.due', { count: deck.due_count })}</span>
						{:else}
							<span class="due-zero">{t('dashboard.due', { count: 0 })}</span>
						{/if}
					</div>
				</a>
				<div class="deck-actions">
					<a href="/decks/{deck.id}/cards" class="deck-action-btn" aria-label="{t('dashboard.browse')} {deck.name}" title={t('dashboard.browse')}>
						<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M7 15h4"/></svg>
					</a>
					<button class="deck-action-btn" aria-label="{t('dashboard.export')} {deck.name}" title={t('dashboard.export')} disabled={exportingDeckId === deck.id} onclick={() => exportDeck(deck.id, deck.name)}>
						{#if exportingDeckId === deck.id}
							<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48 2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48 2.83-2.83"/></svg>
						{:else}
							<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
						{/if}
					</button>
					<a href="/decks/{deck.id}/settings" class="deck-action-btn" aria-label="{t('dashboard.settings')} {deck.name}" title={t('dashboard.settings')}>
						<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
					</a>
					<a href="/decks/{deck.id}/stats" class="deck-action-btn" aria-label="{t('dashboard.stats')} {deck.name}" title={t('dashboard.stats')}>
						<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
					</a>
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
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.65rem 1.25rem;
		background: #2a2a4e;
		color: #c0c0e0;
		border-radius: 8px;
		cursor: pointer;
		font-size: 0.9rem;
		border: 1px solid #3a3a60;
		transition: background 0.15s, border-color 0.15s;
	}

	.upload-btn:hover {
		background: #333360;
		border-color: #5a5a8e;
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
		border-left: 3px solid transparent;
		transition: border-color 0.15s;
	}

	.deck-card.has-due {
		border-left-color: #6ecb63;
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
		align-items: center;
		gap: 0.6rem;
		font-size: 0.85rem;
		color: #a8a8b8;
	}

	.due-badge {
		display: inline-block;
		padding: 0.15rem 0.55rem;
		background: rgba(110, 203, 99, 0.15);
		color: #6ecb63;
		font-weight: 600;
		border-radius: 99px;
		font-size: 0.8rem;
	}

	.due-zero {
		color: #606070;
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
		color: #7070a0;
		text-decoration: none;
		transition: background 0.15s, color 0.15s;
	}

	.deck-action-btn:hover {
		background: #2a2a4e;
		color: #c0c0e0;
	}

	.deck-action-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Skeleton loader for deck list */
	.skeleton-body {
		flex: 1;
		padding: 1rem 1.25rem;
	}

	.skeleton-title,
	.skeleton-meta {
		border-radius: 4px;
		background: linear-gradient(90deg, #2a2a4e 25%, #353560 50%, #2a2a4e 75%);
		background-size: 200% 100%;
		animation: skeleton-shimmer 1.4s ease-in-out infinite;
	}

	.skeleton-title {
		height: 1rem;
		width: 42%;
		margin-bottom: 0.5rem;
	}

	.skeleton-meta {
		height: 0.75rem;
		width: 28%;
		animation-delay: 0.1s;
	}

	@keyframes skeleton-shimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}

</style>

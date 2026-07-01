<script lang="ts">
	import { browser } from '$app/environment';
	// parseApkg / buildApkg pull in sql.js (~1 MB WASM-backed) — only needed for deck
	// import/export, so they're dynamically imported inside those handlers to keep the
	// home page's initial bundle small.
	import OnboardingChecklist from '$lib/components/OnboardingChecklist.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import { t } from '$lib/i18n';
	import { preloadTTS } from '$lib/client/audio';
	import { getPrepareAudioAhead } from '$lib/client/preferences';
	import { clientCardSanitizer } from '$lib/client/card-sanitize';
	import type { DeckWithDueCount } from '$lib/types';
	import type { UserVoiceSettings } from '$lib/voice';

	type ApiKeyStatus = { openai: boolean; deepgram: boolean; anthropic: boolean; elevenlabs: boolean };
	type NextCardsPreview = { cards: { fields: string; card_type: string }[] };

	let decks = $state<DeckWithDueCount[]>([]);
	let importing = $state(false);
	let importStatus = $state('');
	let exportError = $state('');
	let exportSuccess = $state('');
	let loading = $state(true);
	let importInput = $state<HTMLInputElement | null>(null);

	function triggerImport() {
		importInput?.click();
	}

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
			const data = (await res.json()) as { decks: DeckWithDueCount[]; has_reviewed?: boolean };
			decks = data.decks;
			hasReviewed = Boolean(data.has_reviewed);
			// Warm up TTS cache for the first due card of each deck with cards due.
			// Limited to 3 decks to avoid hammering the TTS endpoint on large collections.
			// The audioCache is module-level so these buffers are already decoded when
			// the user navigates to the review page.
			prefetchDueDecksTTS(data.decks);
		}
		loading = false;
	}

	function prefetchDueDecksTTS(allDecks: DeckWithDueCount[]) {
		if (!getPrepareAudioAhead()) return;

		const targets = allDecks.filter((d) => d.due_count > 0).slice(0, 3);
		for (const deck of targets) {
			fetch(`/api/cards/next?${new URLSearchParams({ deckId: deck.id, limit: '1' })}`)
				.then(async (r): Promise<NextCardsPreview | null> => r.ok ? await r.json() as NextCardsPreview : null)
				.then((data) => {
					const card = data?.cards?.[0];
					if (!card) return;
					const fields = JSON.parse(card.fields) as { value: string }[];
					if (!fields.length) return;
					const firstValue = fields[0]?.value ?? '';
					const isCloze = card.card_type === 'cloze' || /\{\{c\d+::/.test(firstValue);
					const rawHtml = isCloze
						? firstValue.replace(/\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g, (_m, _a, hint) => hint || 'blank')
						: firstValue;
					const plain = clientCardSanitizer.toText(rawHtml);
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
		importStatus = $t('import.parsing');

		try {
			const { parseApkg } = await import('$lib/client/anki-parser');
			const parsed = await parseApkg(file);
			importStatus = $t('import.found', { cards: parsed.cards.length, decks: parsed.decks.length });

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
			importStatus = $t('import.done', { cards: result.cardCount, media: result.mediaCount });

			await loadDecks();
		} catch (err) {
			importStatus = $t('import.error', { message: err instanceof Error ? err.message : 'Import failed' });
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

			const { buildApkg, extractMediaFilenames } = await import('$lib/client/apkg-export');

			// Fetch media files referenced in note fields
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const mediaFilenames = extractMediaFilenames(data.notes as any);
			const mediaMap = new Map<string, Uint8Array>();
			const mediaFetches = [...mediaFilenames].map(async (filename) => {
				try {
					const mediaRes = await fetch(`/api/media/${encodeURIComponent(filename)}`);
					if (mediaRes.ok) {
						const buf = await mediaRes.arrayBuffer();
						mediaMap.set(filename, new Uint8Array(buf));
					}
				} catch {
					// Skip media files that can't be fetched
				}
			});
			await Promise.all(mediaFetches);

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const apkg = await buildApkg(data.deck as any, data.notes as any, data.cards as any, mediaMap);

			const blob = new Blob([apkg.buffer as ArrayBuffer], { type: 'application/octet-stream' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${deckName.replace(/[^a-zA-Z0-9]/g, '_')}.apkg`;
			a.click();
			URL.revokeObjectURL(url);
			exportSuccess = $t('dashboard.exportDone', { name: deckName });
			setTimeout(() => { exportSuccess = ''; }, 4000);
		} catch (err) {
			exportError = $t('dashboard.exportFailed', { error: err instanceof Error ? err.message : 'Unknown error' });
			setTimeout(() => { exportError = ''; }, 6000);
		} finally {
			exportingDeckId = '';
		}
	}

	// Load decks and onboarding state on mount
	$effect(() => {
		loadDecks();
		// Fetch key status for onboarding
		Promise.all([
			fetch('/api/settings/api-keys').then(async (r): Promise<ApiKeyStatus | null> => r.ok ? await r.json() as ApiKeyStatus : null),
			fetch('/api/settings/voice').then(async (r): Promise<{ settings: UserVoiceSettings } | null> => r.ok ? await r.json() as { settings: UserVoiceSettings } : null)
		]).then(([keys, voice]) => {
			if (!keys) return;
			const provider = voice?.settings.voice_provider ?? 'elevenlabs';
			hasRequiredKeys = provider === 'openai_deepgram'
				? keys.openai && keys.deepgram
				: keys.elevenlabs;
		}).catch(() => {});
	});
</script>

<h1>{$t('dashboard.title')}</h1>

<input type="file" accept=".apkg" bind:this={importInput} onchange={handleFileUpload} disabled={importing} hidden />

{#if showOnboarding && !loading}
	<OnboardingChecklist
		{hasRequiredKeys}
		hasDecks={decks.length > 0}
		{hasReviewed}
		onDismiss={dismissOnboarding}
		onImport={triggerImport}
	/>
{/if}

<section class="upload">
	<button class="upload-btn" disabled={importing} onclick={triggerImport}>
		{#if importing}
			<Spinner size={16} />
		{:else}
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
		{/if}
		{importing ? $t('dashboard.importing') : $t('dashboard.import')}
	</button>
	{#if importStatus}
		<p class="status">{importStatus}</p>
	{/if}
	{#if importing}
		<div class="import-progress" role="progressbar" aria-label={$t('dashboard.importing')}>
			<div class="import-progress-fill"></div>
		</div>
	{/if}

	{#if exportError}
		<p class="status status-err" role="alert">
			{exportError}
			<button class="status-dismiss" aria-label={$t('common.dismiss')} onclick={() => (exportError = '')}>×</button>
		</p>
	{/if}
	{#if exportSuccess}
		<p class="status status-ok" role="status">{exportSuccess}</p>
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
{:else if decks.length === 0 && !showOnboarding}
	<div class="onboarding">
		<div class="onboarding-icon">
			<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
				<rect x="8" y="12" width="48" height="40" rx="6" stroke="var(--primary)" stroke-width="2.5" fill="none"/>
				<path d="M24 32 L30 38 L40 26" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
				<circle cx="48" cy="16" r="8" fill="var(--primary)"/>
				<path d="M48 12 L48 20 M44 16 L52 16" stroke="var(--text)" stroke-width="2" stroke-linecap="round"/>
			</svg>
		</div>
		<h2>{$t('onboarding.welcome')}</h2>
		<p class="onboarding-desc">{$t('onboarding.desc')}</p>
		<p class="onboarding-steps">{@html $t('onboarding.steps')}</p>
		<button class="btn-primary primary-cta" disabled={importing} onclick={triggerImport}>
			{#if importing}<Spinner size={18} />{/if}
			{importing ? $t('dashboard.importing') : $t('dashboard.import')}
		</button>
	</div>
{:else}
	<ul class="deck-list">
		{#each decks as deck (deck.id)}
			<li class="deck-card" class:has-due={deck.due_count > 0} aria-label="{deck.name} deck, {deck.card_count} cards, {deck.due_count} due">
				<a href="/review/{deck.id}" class="deck-link">
					<h2>{deck.name}</h2>
					<div class="deck-stats">
						<span>{$t('dashboard.cards', { count: deck.card_count })}</span>
						{#if deck.due_count > 0}
							<span class="due-badge">{$t('dashboard.due', { count: deck.due_count })}</span>
						{:else}
							<span class="due-zero">{$t('dashboard.due', { count: 0 })}</span>
						{/if}
					</div>
				</a>
				<div class="deck-actions">
					<a href="/decks/{deck.id}/cards" class="deck-action-btn" aria-label="{$t('dashboard.browse')} {deck.name}" title={$t('dashboard.browse')}>
						<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M7 15h4"/></svg>
					</a>
					<button class="deck-action-btn" aria-label="{$t('dashboard.export')} {deck.name}" title={$t('dashboard.export')} disabled={exportingDeckId === deck.id} onclick={() => exportDeck(deck.id, deck.name)}>
						{#if exportingDeckId === deck.id}
							<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48 2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48 2.83-2.83"/></svg>
						{:else}
							<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
						{/if}
					</button>
					<a href="/decks/{deck.id}/settings" class="deck-action-btn" aria-label="{$t('dashboard.settings')} {deck.name}" title={$t('dashboard.settings')}>
						<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
					</a>
					<a href="/decks/{deck.id}/stats" class="deck-action-btn" aria-label="{$t('dashboard.stats')} {deck.name}" title={$t('dashboard.stats')}>
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
		background: transparent;
		color: var(--text-muted);
		border-radius: var(--r-md);
		cursor: pointer;
		font-size: 0.9rem;
		font-family: inherit;
		font-weight: 600;
		border: 1px solid var(--border);
		transition: color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
	}

	.upload-btn:hover:not(:disabled) {
		color: var(--text);
		border-color: var(--border-strong);
	}

	.upload-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.status {
		margin-top: 0.75rem;
		color: var(--text-muted);
		font-size: 0.9rem;
	}

	.import-progress {
		margin-top: 0.6rem;
		height: 3px;
		max-width: 320px;
		border-radius: var(--r-pill);
		background: var(--border-muted);
		overflow: hidden;
	}

	.import-progress-fill {
		height: 100%;
		width: 40%;
		border-radius: var(--r-pill);
		background: var(--primary);
		animation: indeterminate 1.2s var(--ease) infinite;
	}

	@keyframes indeterminate {
		0% { transform: translateX(-100%); }
		100% { transform: translateX(350%); }
	}

	.status-err {
		color: var(--danger-soft);
		background: var(--danger-tint);
		border: 1px solid var(--danger-border);
		border-radius: var(--r-md);
		padding: 0.6rem 0.75rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.status-dismiss {
		background: none;
		border: none;
		color: inherit;
		font-size: 1.1rem;
		cursor: pointer;
		padding: 0 0.25rem;
		line-height: 1;
	}
	.status-dismiss:hover { color: var(--text); }

	.status-ok {
		color: var(--success);
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
		color: var(--text-muted);
		font-size: 0.95rem;
		line-height: 1.5;
		margin-bottom: 1rem;
	}

	.onboarding-steps {
		color: var(--text-muted);
		font-size: 0.85rem;
		line-height: 1.5;
		margin-bottom: 1.5rem;
	}

	/* Layout-only on top of the global .btn-primary recipe. */
	.primary-cta {
		padding: 0.9rem 2rem;
		font-size: 1.05rem;
		border-radius: var(--r-lg);
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
		background: var(--surface);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-lg);
		overflow: hidden;
		flex-wrap: wrap;
		border-left: 3px solid transparent;
		transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
	}

	.deck-card:hover {
		border-color: var(--border-strong);
		box-shadow: var(--shadow-sm);
	}

	.deck-card.has-due,
	.deck-card.has-due:hover {
		border-left-color: var(--success);
	}

	.deck-link {
		flex: 1;
		padding: 1rem 1.25rem;
		color: inherit;
		text-decoration: none;
		min-width: 0;
	}

	.deck-link:hover {
		background: rgba(255, 255, 255, 0.03);
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
		color: var(--text-muted);
	}

	.due-badge {
		display: inline-block;
		padding: 0.15rem 0.55rem;
		background: var(--success-tint);
		color: var(--success);
		font-weight: 600;
		border-radius: var(--r-pill);
		font-size: 0.8rem;
	}

	.due-zero {
		color: var(--text-subtle);
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
		width: 44px;
		height: 44px;
		border-radius: var(--r-sm);
		border: none;
		background: none;
		cursor: pointer;
		color: var(--text-subtle);
		text-decoration: none;
		transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
	}

	.deck-action-btn:hover {
		background: var(--surface-elevated);
		color: var(--text);
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
		background: linear-gradient(90deg, var(--border-muted) 25%, var(--surface-elevated) 50%, var(--border-muted) 75%);
		background-size: 200% 100%;
		animation: shimmer 1.4s ease-in-out infinite;
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

</style>

<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import CardEditModal from '$lib/components/CardEditModal.svelte';
	import type { BrowseCard, NoteField } from '$lib/types';

	const deckId = $derived($page.params.id);

	let cards = $state<BrowseCard[]>([]);
	let total = $state(0);
	let currentPage = $state(1);
	let pageSize = $state(20);
	let loading = $state(true);
	let deckName = $state('');
	let searchQuery = $state('');
	let stateFilter = $state<'all' | 'new' | 'learning' | 'review' | 'suspended'>('all');
	let selected = $state<Set<string>>(new Set());
	let bulkLoading = $state(false);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	// Edit modal state
	let modalOpen = $state(false);
	let modalCardId = $state<string | undefined>(undefined);
	let modalFields = $state<NoteField[]>([]);
	let modalTags = $state('');
	let modalCreateMode = $state(false);

	async function loadCards() {
		loading = true;
		const params = new URLSearchParams({
			page: String(currentPage),
			pageSize: String(pageSize),
			state: stateFilter
		});
		if (searchQuery) params.set('q', searchQuery);

		const res = await fetch(`/api/decks/${deckId}/cards?${params}`);
		if (res.ok) {
			const data = (await res.json()) as { cards: BrowseCard[]; total: number; page: number; pageSize: number };
			cards = data.cards;
			total = data.total;
			currentPage = data.page;
			pageSize = data.pageSize;
		}
		loading = false;
	}

	async function loadDeckName() {
		const res = await fetch(`/api/decks/${deckId}`);
		if (res.ok) {
			const data = (await res.json()) as { deck: { name: string } };
			deckName = data.deck.name;
		}
	}

	function handleSearch() {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			currentPage = 1;
			selected = new Set();
			loadCards();
		}, 300);
	}

	function setStateFilter(s: typeof stateFilter) {
		stateFilter = s;
		currentPage = 1;
		selected = new Set();
		loadCards();
	}

	function prevPage() {
		if (currentPage > 1) {
			currentPage--;
			selected = new Set();
			loadCards();
		}
	}

	function nextPage() {
		if (currentPage * pageSize < total) {
			currentPage++;
			selected = new Set();
			loadCards();
		}
	}

	function toggleSelect(id: string) {
		const next = new Set(selected);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selected = next;
	}

	function toggleSelectAll() {
		if (selected.size === cards.length) {
			selected = new Set();
		} else {
			selected = new Set(cards.map((c) => c.id));
		}
	}

	async function bulkAction(action: 'suspend' | 'unsuspend') {
		if (selected.size === 0) return;
		bulkLoading = true;
		await fetch(`/api/decks/${deckId}/cards/bulk`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action, cardIds: [...selected] })
		});
		selected = new Set();
		bulkLoading = false;
		await loadCards();
	}

	function openEditModal(card: BrowseCard) {
		let fields: NoteField[];
		try { fields = JSON.parse(card.fields); } catch { fields = []; }
		modalCardId = card.id;
		modalFields = fields;
		modalTags = card.tags;
		modalCreateMode = false;
		modalOpen = true;
	}

	function openCreateModal() {
		modalCardId = undefined;
		modalFields = [{ name: 'Front', value: '' }, { name: 'Back', value: '' }];
		modalTags = '';
		modalCreateMode = true;
		modalOpen = true;
	}

	function onModalSave() {
		modalOpen = false;
		loadCards();
	}

	function stateName(s: number, suspended: number): string {
		if (suspended) return 'Suspended';
		if (s === 0) return 'New';
		if (s === 1 || s === 3) return 'Learning';
		if (s === 2) return 'Review';
		return 'Unknown';
	}

	function stateClass(s: number, suspended: number): string {
		if (suspended) return 'suspended';
		if (s === 0) return 'new';
		if (s === 1 || s === 3) return 'learning';
		if (s === 2) return 'review';
		return '';
	}

	function truncate(text: string, len: number): string {
		return text.length > len ? text.slice(0, len) + '...' : text;
	}

	function getFrontText(fieldsJson: string): string {
		try {
			const fields: NoteField[] = JSON.parse(fieldsJson);
			const raw = fields[0]?.value ?? '';
			// Strip HTML
			const div = document.createElement('div');
			div.innerHTML = raw;
			return div.textContent ?? '';
		} catch {
			return '';
		}
	}

	function formatDate(iso: string): string {
		try {
			const d = new Date(iso);
			return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		} catch {
			return '';
		}
	}

	const totalPages = $derived(Math.max(1, Math.ceil(total / pageSize)));

	onMount(() => {
		loadDeckName();
		loadCards();
	});
</script>

<div class="browser">
	<div class="header">
		<a href="/" class="back-link">&larr; Dashboard</a>
		<h1>{deckName ? `${deckName} — Cards` : 'Cards'}</h1>
	</div>

	<div class="controls">
		<input
			type="text"
			class="search-input"
			placeholder="Search cards..."
			bind:value={searchQuery}
			oninput={handleSearch}
		/>
		<button class="new-card-btn" onclick={openCreateModal}>New Card</button>
	</div>

	<div class="filters">
		{#each ['all', 'new', 'learning', 'review', 'suspended'] as s}
			<button
				class="filter-pill"
				class:active={stateFilter === s}
				onclick={() => setStateFilter(s as typeof stateFilter)}
			>
				{s.charAt(0).toUpperCase() + s.slice(1)}
			</button>
		{/each}
	</div>

	{#if selected.size > 0}
		<div class="bulk-bar">
			<span>{selected.size} selected</span>
			<button class="bulk-btn" disabled={bulkLoading} onclick={() => bulkAction('suspend')}>Suspend</button>
			<button class="bulk-btn" disabled={bulkLoading} onclick={() => bulkAction('unsuspend')}>Unsuspend</button>
		</div>
	{/if}

	{#if loading}
		<p class="loading-msg">Loading...</p>
	{:else if cards.length === 0}
		<p class="empty-msg">No cards found.</p>
	{:else}
		<div class="card-list">
			<div class="card-list-header">
				<label class="checkbox-cell">
					<input type="checkbox" checked={selected.size === cards.length && cards.length > 0} onchange={toggleSelectAll} />
				</label>
				<span class="col-front">Front</span>
				<span class="col-state">State</span>
				<span class="col-due">Due</span>
				<span class="col-reps">Reps</span>
				<span class="col-lapses">Lapses</span>
			</div>

			{#each cards as card (card.id)}
				<div class="card-row" role="button" tabindex="0" onclick={() => openEditModal(card)} onkeydown={(e) => { if (e.key === 'Enter') openEditModal(card); }}>
					<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
					<span class="checkbox-cell" onclick={(e) => e.stopPropagation()}>
						<input type="checkbox" checked={selected.has(card.id)} onchange={() => toggleSelect(card.id)} />
					</span>
					<span class="col-front">{truncate(getFrontText(card.fields), 60)}</span>
					<span class="col-state"><span class="state-badge {stateClass(card.fsrs_state, card.suspended)}">{stateName(card.fsrs_state, card.suspended)}</span></span>
					<span class="col-due">{formatDate(card.due_at)}</span>
					<span class="col-reps">{card.fsrs_reps}</span>
					<span class="col-lapses">{card.fsrs_lapses}</span>
				</div>
			{/each}
		</div>

		<div class="pagination">
			<button class="page-btn" disabled={currentPage <= 1} onclick={prevPage}>Prev</button>
			<span class="page-info">{currentPage} / {totalPages}</span>
			<button class="page-btn" disabled={currentPage >= totalPages} onclick={nextPage}>Next</button>
		</div>
	{/if}
</div>

<CardEditModal
	open={modalOpen}
	deckId={deckId ?? ''}
	cardId={modalCardId ?? ''}
	initialFields={modalFields}
	initialTags={modalTags}
	createMode={modalCreateMode}
	onclose={() => { modalOpen = false; }}
	onsave={onModalSave}
/>

<style>
	.browser {
		max-width: 800px;
		margin: 0 auto;
	}

	.header {
		margin-bottom: 1.5rem;
	}

	.back-link {
		color: #a8a8b8;
		text-decoration: none;
		font-size: 0.85rem;
	}

	.back-link:hover {
		color: #e0e0ff;
	}

	h1 {
		margin: 0.5rem 0 0;
		font-size: 1.4rem;
	}

	.controls {
		display: flex;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.search-input {
		flex: 1;
		padding: 0.6rem 0.8rem;
		background: #22223a;
		border: 1px solid #3a3a5e;
		border-radius: 8px;
		color: #e0e0ff;
		font-size: 0.9rem;
	}

	.search-input:focus {
		outline: none;
		border-color: #5a5a8e;
	}

	.new-card-btn {
		padding: 0.6rem 1.2rem;
		background: #4a4a8e;
		border: none;
		color: #e0e0ff;
		border-radius: 8px;
		cursor: pointer;
		font-size: 0.9rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.new-card-btn:hover {
		background: #5a5aae;
	}

	.filters {
		display: flex;
		gap: 0.4rem;
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}

	.filter-pill {
		padding: 0.35rem 0.8rem;
		background: #22223a;
		border: 1px solid #3a3a5e;
		color: #a8a8b8;
		border-radius: 20px;
		cursor: pointer;
		font-size: 0.8rem;
	}

	.filter-pill:hover {
		border-color: #5a5a8e;
		color: #e0e0ff;
	}

	.filter-pill.active {
		background: #3a3a6e;
		border-color: #5a5a8e;
		color: #e0e0ff;
		font-weight: 600;
	}

	.bulk-bar {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0.75rem;
		background: #2a2a4e;
		border-radius: 8px;
		margin-bottom: 1rem;
		font-size: 0.85rem;
		color: #e0e0ff;
	}

	.bulk-btn {
		padding: 0.3rem 0.8rem;
		background: #3a3a6e;
		border: none;
		color: #e0e0ff;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8rem;
	}

	.bulk-btn:hover {
		background: #4a4a8e;
	}

	.bulk-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.loading-msg, .empty-msg {
		color: #a8a8b8;
		text-align: center;
		padding: 2rem;
	}

	.card-list {
		border: 1px solid #3a3a5e;
		border-radius: 8px;
		overflow: hidden;
	}

	.card-list-header {
		display: flex;
		align-items: center;
		padding: 0.5rem 0.75rem;
		background: #22223a;
		font-size: 0.75rem;
		font-weight: 600;
		color: #8080a0;
		text-transform: uppercase;
		gap: 0.5rem;
	}

	.card-row {
		display: flex;
		align-items: center;
		padding: 0.6rem 0.75rem;
		border-top: 1px solid #2a2a4e;
		cursor: pointer;
		gap: 0.5rem;
		font-size: 0.85rem;
	}

	.card-row:hover {
		background: #22223a;
	}

	.checkbox-cell {
		flex: 0 0 24px;
		display: flex;
		align-items: center;
	}

	.col-front {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.col-state { flex: 0 0 80px; }
	.col-due { flex: 0 0 60px; color: #a8a8b8; }
	.col-reps { flex: 0 0 40px; text-align: center; color: #a8a8b8; }
	.col-lapses { flex: 0 0 50px; text-align: center; color: #a8a8b8; }

	.state-badge {
		padding: 0.15rem 0.4rem;
		border-radius: 4px;
		font-size: 0.7rem;
		font-weight: 600;
	}

	.state-badge.new { background: #20204a; color: #88bbff; }
	.state-badge.learning { background: #3a2a5e; color: #ccaaff; }
	.state-badge.review { background: #204a20; color: #88ff88; }
	.state-badge.suspended { background: #4a2020; color: #ff8888; }

	.pagination {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		margin-top: 1rem;
		padding-bottom: 2rem;
	}

	.page-btn {
		padding: 0.4rem 1rem;
		background: #22223a;
		border: 1px solid #3a3a5e;
		color: #a8a8b8;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.page-btn:hover:not(:disabled) {
		border-color: #5a5a8e;
		color: #e0e0ff;
	}

	.page-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.page-info {
		color: #a8a8b8;
		font-size: 0.85rem;
	}

	@media (max-width: 600px) {
		.col-reps, .col-lapses, .col-due {
			display: none;
		}
	}
</style>

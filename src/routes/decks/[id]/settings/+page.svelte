<script lang="ts">
	import { page } from '$app/stores';

	const deckId = $derived($page.params.id);

	let loading = $state(true);
	let saving = $state(false);
	let saveStatus = $state('');
	let deckName = $state('');

	let newCardsPerDay = $state(20);
	let maxReviewsPerDay = $state(200);
	let desiredRetention = $state(0.9);
	let maxInterval = $state(36500);
	let leechThreshold = $state(8);

	async function loadSettings() {
		try {
			const [deckRes, settingsRes] = await Promise.all([
				fetch(`/api/decks/${deckId}`),
				fetch(`/api/decks/${deckId}/settings`)
			]);

			if (deckRes.ok) {
				const data = (await deckRes.json()) as { deck: { name: string } };
				deckName = data.deck.name;
			}

			if (settingsRes.ok) {
				const data = (await settingsRes.json()) as { settings: Record<string, number> };
				const s = data.settings;
				newCardsPerDay = s.new_cards_per_day;
				maxReviewsPerDay = s.max_reviews_per_day;
				desiredRetention = s.desired_retention;
				maxInterval = s.max_interval;
				leechThreshold = s.leech_threshold;
			}
		} catch {
			saveStatus = 'Failed to load settings';
		}
		loading = false;
	}

	async function save() {
		saving = true;
		saveStatus = '';

		try {
			const res = await fetch(`/api/decks/${deckId}/settings`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					new_cards_per_day: newCardsPerDay,
					max_reviews_per_day: maxReviewsPerDay,
					desired_retention: desiredRetention,
					max_interval: maxInterval,
					leech_threshold: leechThreshold
				})
			});

			if (res.ok) {
				saveStatus = 'Saved';
				setTimeout(() => { saveStatus = ''; }, 2000);
			} else {
				saveStatus = 'Failed to save';
			}
		} catch {
			saveStatus = 'Failed to save';
		}
		saving = false;
	}

	$effect(() => {
		loadSettings();
	});
</script>

<div class="settings-page">
	<a href="/" class="back-link">&larr; Dashboard</a>

	<h1>Settings{deckName ? ` — ${deckName}` : ''}</h1>

	{#if loading}
		<p class="loading">Loading...</p>
	{:else}
		<form onsubmit={(e) => { e.preventDefault(); save(); }}>
			<div class="field">
				<label for="newPerDay">New cards per day</label>
				<input id="newPerDay" type="number" min="0" max="9999" bind:value={newCardsPerDay} />
			</div>

			<div class="field">
				<label for="maxReviews">Max reviews per day</label>
				<input id="maxReviews" type="number" min="0" max="9999" bind:value={maxReviewsPerDay} />
			</div>

			<div class="field">
				<label for="retention">Desired retention: {Math.round(desiredRetention * 100)}%</label>
				<input id="retention" type="range" min="0.5" max="0.99" step="0.01" bind:value={desiredRetention} />
				<span class="helper">Higher = more reviews but better recall. Default 90%.</span>
			</div>

			<div class="field">
				<label for="maxInterval">Max interval (days)</label>
				<input id="maxInterval" type="number" min="1" max="36500" bind:value={maxInterval} />
				<span class="helper">{maxInterval >= 365 ? `${(maxInterval / 365).toFixed(1)} years` : `${maxInterval} days`}</span>
			</div>

			<div class="field">
				<label for="leechThreshold">Leech threshold (lapses)</label>
				<input id="leechThreshold" type="number" min="1" max="99" bind:value={leechThreshold} />
				<span class="helper">Cards with this many lapses get auto-suspended.</span>
			</div>

			<button type="submit" class="save-btn" disabled={saving}>
				{saving ? 'Saving...' : 'Save'}
			</button>

			{#if saveStatus}
				<span class="save-status" class:success={saveStatus === 'Saved'} class:error={saveStatus !== 'Saved'}>{saveStatus}</span>
			{/if}
		</form>
	{/if}
</div>

<style>
	.settings-page {
		max-width: 500px;
		margin: 0 auto;
		padding: 1rem;
	}

	.back-link {
		color: #a8a8b8;
		text-decoration: none;
		font-size: 0.9rem;
	}

	.back-link:hover {
		color: #e0e0ff;
	}

	h1 {
		margin: 1rem 0 1.5rem;
		font-size: 1.4rem;
	}

	.loading {
		color: #a8a8b8;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	label {
		font-size: 0.9rem;
		font-weight: 600;
		color: #b0b0d0;
	}

	input[type="number"] {
		padding: 0.5rem 0.75rem;
		background: #22223a;
		border: 1px solid #3a3a5e;
		border-radius: 6px;
		color: #e0e0ff;
		font-size: 1rem;
		width: 120px;
	}

	input[type="number"]:focus {
		outline: none;
		border-color: #5a5a8e;
	}

	input[type="range"] {
		width: 100%;
		accent-color: #4a4a8e;
	}

	.helper {
		font-size: 0.75rem;
		color: #8080a0;
	}

	.save-btn {
		padding: 0.6rem 1.5rem;
		background: #4a4a8e;
		color: #e0e0ff;
		border: none;
		border-radius: 8px;
		font-size: 1rem;
		cursor: pointer;
		align-self: flex-start;
	}

	.save-btn:hover {
		background: #5a5aae;
	}

	.save-btn:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.save-status {
		font-size: 0.85rem;
		font-weight: 600;
	}

	.save-status.success {
		color: #6ecb63;
	}

	.save-status.error {
		color: #ff6666;
	}
</style>

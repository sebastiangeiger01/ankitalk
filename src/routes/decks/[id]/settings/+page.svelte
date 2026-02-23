<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { locale, t } from '$lib/i18n';

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
	let learningSteps = $state('1,10');
	let relearningSteps = $state('10');

	let loc = $state('en');
	locale.subscribe((v) => { loc = v; });

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
				const data = (await settingsRes.json()) as { settings: Record<string, number | string> };
				const s = data.settings;
				newCardsPerDay = s.new_cards_per_day as number;
				maxReviewsPerDay = s.max_reviews_per_day as number;
				desiredRetention = s.desired_retention as number;
				maxInterval = s.max_interval as number;
				leechThreshold = s.leech_threshold as number;
				learningSteps = (s.learning_steps as string) ?? '1,10';
				relearningSteps = (s.relearning_steps as string) ?? '10';
			}
		} catch {
			saveStatus = t('settings.loadFailed');
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
					leech_threshold: leechThreshold,
				learning_steps: learningSteps,
				relearning_steps: relearningSteps
				})
			});

			if (res.ok) {
				saveStatus = t('settings.saved');
				setTimeout(() => { saveStatus = ''; }, 2000);
			} else {
				saveStatus = t('settings.saveFailed');
			}
		} catch {
			saveStatus = t('settings.saveFailed');
		}
		saving = false;
	}

	let resetting = $state(false);
	let deleting = $state(false);

	async function deleteDeck() {
		if (!confirm(t('settings.deleteConfirm', { name: deckName }))) return;

		deleting = true;
		try {
			const res = await fetch(`/api/decks/${deckId}`, { method: 'DELETE' });
			if (res.ok) {
				goto('/');
			}
		} catch {
			saveStatus = t('settings.saveFailed');
		}
		deleting = false;
	}

	async function resetProgress() {
		if (!confirm(t('settings.resetConfirm', { name: deckName }))) return;

		resetting = true;
		try {
			const res = await fetch(`/api/decks/${deckId}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'reset' })
			});
			if (res.ok) {
				saveStatus = t('settings.resetDone');
				setTimeout(() => { saveStatus = ''; }, 3000);
			}
		} catch {
			saveStatus = t('settings.saveFailed');
		}
		resetting = false;
	}

	$effect(() => {
		loadSettings();
	});
</script>

<div class="settings-page">
	<a href="/" class="back-link">&larr; {t('settings.dashboard')}</a>

	<h1>{t('settings.title')}{deckName ? ` — ${deckName}` : ''}</h1>

	{#if loading}
		<p class="loading">{t('settings.loading')}</p>
	{:else}
		<form onsubmit={(e) => { e.preventDefault(); save(); }}>
			<div class="field">
				<label for="newPerDay">{t('settings.newPerDay')}</label>
				<input id="newPerDay" type="number" min="0" max="9999" bind:value={newCardsPerDay} />
			</div>

			<div class="field">
				<label for="maxReviews">{t('settings.maxReviews')}</label>
				<input id="maxReviews" type="number" min="0" max="9999" bind:value={maxReviewsPerDay} />
			</div>

			<div class="field">
				<label for="retention">{t('settings.retention', { pct: Math.round(desiredRetention * 100) })}</label>
				<input id="retention" type="range" min="0.5" max="0.99" step="0.01" bind:value={desiredRetention} />
				<span class="helper">{t('settings.retentionHelper')}</span>
			</div>

			<div class="field">
				<label for="maxInterval">{t('settings.maxInterval')}</label>
				<input id="maxInterval" type="number" min="1" max="36500" bind:value={maxInterval} />
				<span class="helper">{maxInterval >= 365 ? t('settings.maxIntervalYears', { years: (maxInterval / 365).toFixed(1) }) : t('settings.maxIntervalDays', { days: maxInterval })}</span>
			</div>

			<div class="field">
				<label for="leechThreshold">{t('settings.leechThreshold')}</label>
				<input id="leechThreshold" type="number" min="1" max="99" bind:value={leechThreshold} />
				<span class="helper">{t('settings.leechHelper')}</span>
			</div>

			<div class="field">
				<label for="learningSteps">{t('settings.learningSteps')}</label>
				<input id="learningSteps" type="text" bind:value={learningSteps} placeholder="1, 10" />
				<span class="helper">{t('settings.learningStepsHelper')}</span>
			</div>

			<div class="field">
				<label for="relearningSteps">{t('settings.relearningSteps')}</label>
				<input id="relearningSteps" type="text" bind:value={relearningSteps} placeholder="10" />
				<span class="helper">{t('settings.relearningStepsHelper')}</span>
			</div>

			<button type="submit" class="save-btn" disabled={saving}>
				{saving ? t('settings.saving') : t('settings.save')}
			</button>

			{#if saveStatus}
				<span class="save-status" class:success={saveStatus === t('settings.saved')} class:error={saveStatus !== t('settings.saved')}>{saveStatus}</span>
			{/if}
		</form>

		<div class="danger-zone">
			<h2>{t('settings.dangerZone')}</h2>
			<div class="danger-item">
				<div>
					<strong>{t('settings.resetTitle')}</strong>
					<p class="helper">{t('settings.resetHelper')}</p>
				</div>
				<button class="reset-btn" disabled={resetting} onclick={resetProgress}>
					{resetting ? t('common.loading') : t('settings.resetButton')}
				</button>
			</div>
			<div class="danger-item">
				<div>
					<strong>{t('settings.deleteTitle')}</strong>
					<p class="helper">{t('settings.deleteHelper')}</p>
				</div>
				<button class="reset-btn" disabled={deleting} onclick={deleteDeck}>
					{deleting ? t('common.loading') : t('settings.deleteButton')}
				</button>
			</div>
		</div>
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

	input[type="number"],
	input[type="text"] {
		padding: 0.5rem 0.75rem;
		background: #22223a;
		border: 1px solid #3a3a5e;
		border-radius: 6px;
		color: #e0e0ff;
		font-size: 1rem;
		width: 120px;
	}

	input[type="text"] {
		width: 200px;
	}

	input[type="number"]:focus,
	input[type="text"]:focus {
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

	.danger-zone {
		margin-top: 3rem;
		padding-top: 1.5rem;
		border-top: 1px solid #3a2020;
	}

	.danger-zone h2 {
		font-size: 1rem;
		color: #ff6666;
		margin: 0 0 1rem;
	}

	.danger-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.danger-item p {
		margin: 0.25rem 0 0;
	}

	.reset-btn {
		padding: 0.5rem 1.2rem;
		background: transparent;
		color: #ff6666;
		border: 1px solid #ff6666;
		border-radius: 8px;
		font-size: 0.9rem;
		cursor: pointer;
		white-space: nowrap;
	}

	.reset-btn:hover {
		background: #3a1515;
	}

	.reset-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>

<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { t } from '$lib/i18n';
	import { validateSteps } from '$lib/fsrs';
	import Spinner from '$lib/components/Spinner.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';

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
	// Exam-pin: keep this deck's spoken audio cached (no regeneration) until this date. '' = off.
	let audioKeepUntil = $state('');

	// Client-side validation of the free-text step lists — the server would otherwise
	// silently substitute defaults for junk input.
	const learningStepsCheck = $derived(validateSteps(learningSteps));
	const relearningStepsCheck = $derived(validateSteps(relearningSteps));
	const stepsValid = $derived(learningStepsCheck.valid && relearningStepsCheck.valid);

	function stepsPreview(steps: number[]): string {
		return steps.map((n) => $t('settings.stepsPreviewMin', { n })).join(' · ');
	}

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
				const data = (await settingsRes.json()) as {
					settings: Record<string, number | string>;
					audio_keep_until?: string | null;
				};
				const s = data.settings;
				newCardsPerDay = s.new_cards_per_day as number;
				maxReviewsPerDay = s.max_reviews_per_day as number;
				desiredRetention = s.desired_retention as number;
				maxInterval = s.max_interval as number;
				leechThreshold = s.leech_threshold as number;
				learningSteps = (s.learning_steps as string) ?? '1,10';
				relearningSteps = (s.relearning_steps as string) ?? '10';
				audioKeepUntil = data.audio_keep_until ?? '';
			}
		} catch {
			saveStatus = $t('settings.loadFailed');
		}
		loading = false;
	}

	async function save() {
		if (!stepsValid) return;
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
				relearning_steps: relearningSteps,
				audio_keep_until: audioKeepUntil || null
				})
			});

			if (res.ok) {
				saveStatus = $t('settings.saved');
				setTimeout(() => { saveStatus = ''; }, 2000);
			} else {
				saveStatus = $t('settings.saveFailed');
			}
		} catch {
			saveStatus = $t('settings.saveFailed');
		}
		saving = false;
	}

	let resetting = $state(false);
	let deleting = $state(false);

	let confirmDelete = $state(false);
	let confirmReset = $state(false);

	async function performDelete() {
		confirmDelete = false;
		deleting = true;
		try {
			const res = await fetch(`/api/decks/${deckId}`, { method: 'DELETE' });
			if (res.ok) {
				goto('/');
			}
		} catch {
			saveStatus = $t('settings.saveFailed');
		}
		deleting = false;
	}

	async function performReset() {
		confirmReset = false;
		resetting = true;
		try {
			const res = await fetch(`/api/decks/${deckId}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'reset' })
			});
			if (res.ok) {
				saveStatus = $t('settings.resetDone');
				setTimeout(() => { saveStatus = ''; }, 3000);
			}
		} catch {
			saveStatus = $t('settings.saveFailed');
		}
		resetting = false;
	}

	$effect(() => {
		loadSettings();
	});
</script>

<div class="settings-page">
	<a href="/" class="back-link">&larr; {$t('settings.dashboard')}</a>

	<h1>{$t('settings.title')}{deckName ? ` — ${deckName}` : ''}</h1>

	{#if loading}
		<div class="page-spinner"><Spinner size={28} /></div>
	{:else}
		<form onsubmit={(e) => { e.preventDefault(); save(); }}>
			<div class="field">
				<label for="newPerDay">{$t('settings.newPerDay')}</label>
				<input id="newPerDay" type="number" min="0" max="9999" bind:value={newCardsPerDay} />
			</div>

			<div class="field">
				<label for="maxReviews">{$t('settings.maxReviews')}</label>
				<input id="maxReviews" type="number" min="0" max="9999" bind:value={maxReviewsPerDay} />
			</div>

			<div class="field">
				<label for="retention">{$t('settings.retention', { pct: Math.round(desiredRetention * 100) })}</label>
				<input id="retention" type="range" min="0.5" max="0.99" step="0.01" bind:value={desiredRetention} />
				<span class="helper">{$t('settings.retentionHelper')}</span>
			</div>

			<div class="field">
				<label for="maxInterval">{$t('settings.maxInterval')}</label>
				<input id="maxInterval" type="number" min="1" max="36500" bind:value={maxInterval} />
				<span class="helper">{maxInterval >= 365 ? $t('settings.maxIntervalYears', { years: (maxInterval / 365).toFixed(1) }) : $t('settings.maxIntervalDays', { days: maxInterval })}</span>
			</div>

			<div class="field">
				<label for="leechThreshold">{$t('settings.leechThreshold')}</label>
				<input id="leechThreshold" type="number" min="1" max="99" bind:value={leechThreshold} />
				<span class="helper">{$t('settings.leechHelper')}</span>
			</div>

			<div class="field">
				<label for="learningSteps">{$t('settings.learningSteps')}</label>
				<input
					id="learningSteps"
					type="text"
					bind:value={learningSteps}
					placeholder="1, 10"
					class:invalid={!learningStepsCheck.valid}
					aria-invalid={!learningStepsCheck.valid}
					aria-describedby={learningStepsCheck.valid ? undefined : 'learningStepsError'}
				/>
				{#if learningStepsCheck.valid}
					<span class="steps-preview">&rarr; {stepsPreview(learningStepsCheck.steps)}</span>
				{:else}
					<span class="field-error" id="learningStepsError">{$t('settings.stepsInvalid')}</span>
				{/if}
				<span class="helper">{$t('settings.learningStepsHelper')}</span>
			</div>

			<div class="field">
				<label for="relearningSteps">{$t('settings.relearningSteps')}</label>
				<input
					id="relearningSteps"
					type="text"
					bind:value={relearningSteps}
					placeholder="10"
					class:invalid={!relearningStepsCheck.valid}
					aria-invalid={!relearningStepsCheck.valid}
					aria-describedby={relearningStepsCheck.valid ? undefined : 'relearningStepsError'}
				/>
				{#if relearningStepsCheck.valid}
					<span class="steps-preview">&rarr; {stepsPreview(relearningStepsCheck.steps)}</span>
				{:else}
					<span class="field-error" id="relearningStepsError">{$t('settings.stepsInvalid')}</span>
				{/if}
				<span class="helper">{$t('settings.relearningStepsHelper')}</span>
			</div>

			<div class="field">
				<label for="audioKeepUntil">{$t('settings.audioPinTitle')}</label>
				<div class="audio-pin-row">
					<input id="audioKeepUntil" type="date" bind:value={audioKeepUntil} />
					{#if audioKeepUntil}
						<button type="button" class="link-btn" onclick={() => (audioKeepUntil = '')}>
							{$t('settings.audioPinClear')}
						</button>
					{/if}
				</div>
				<span class="helper">{$t('settings.audioPinHelper')}</span>
			</div>

			<button type="submit" class="btn-primary save-btn" disabled={saving || !stepsValid}>
				{#if saving}<Spinner size={14} />{/if}
				{saving ? $t('settings.saving') : $t('settings.save')}
			</button>

			{#if saveStatus}
				<span class="save-status" class:success={saveStatus === $t('settings.saved')} class:error={saveStatus !== $t('settings.saved')}>{saveStatus}</span>
			{/if}
		</form>

		<div class="danger-zone">
			<h2>{$t('settings.dangerZone')}</h2>
			<div class="danger-item">
				<div>
					<strong>{$t('settings.resetTitle')}</strong>
					<p class="helper">{$t('settings.resetHelper')}</p>
				</div>
				<button class="btn-danger reset-btn" disabled={resetting} onclick={() => (confirmReset = true)}>
					{resetting ? $t('common.loading') : $t('settings.resetButton')}
				</button>
			</div>
			<div class="danger-item">
				<div>
					<strong>{$t('settings.deleteTitle')}</strong>
					<p class="helper">{$t('settings.deleteHelper')}</p>
				</div>
				<button class="delete-btn" disabled={deleting} onclick={() => (confirmDelete = true)}>
					{deleting ? $t('common.loading') : $t('settings.deleteButton')}
				</button>
			</div>
		</div>
	{/if}
</div>

<ConfirmDialog
	open={confirmReset}
	title={$t('settings.resetButton')}
	message={$t('settings.resetConfirm', { name: deckName })}
	confirmLabel={$t('settings.resetButton')}
	danger
	onconfirm={performReset}
	oncancel={() => (confirmReset = false)}
/>

<ConfirmDialog
	open={confirmDelete}
	title={$t('settings.deleteButton')}
	message={$t('settings.deleteConfirm', { name: deckName })}
	confirmLabel={$t('common.delete')}
	danger
	onconfirm={performDelete}
	oncancel={() => (confirmDelete = false)}
/>

<style>
	.settings-page {
		max-width: 500px;
		margin: 0 auto;
		padding: 1rem;
	}

	.back-link {
		color: var(--text-muted);
		text-decoration: none;
		font-size: 0.9rem;
	}

	.back-link:hover {
		color: var(--text);
	}

	h1 {
		margin: 1rem 0 1.5rem;
		font-size: 1.4rem;
		/* Deck names are user text and can be arbitrarily long — keep the heading to one line. */
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.page-spinner {
		display: flex;
		justify-content: center;
		padding: 3rem 0;
		color: var(--text-muted);
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
		color: var(--text-muted);
	}

	input[type="number"],
	input[type="text"],
	input[type="date"] {
		padding: 0.5rem 0.75rem;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--r-sm);
		color: var(--text);
		font-size: 1rem;
		width: 120px;
		font-family: inherit;
		transition: border-color var(--t-fast) var(--ease);
	}

	input[type="text"],
	input[type="date"] {
		width: 200px;
	}

	input[type="number"]:focus,
	input[type="text"]:focus,
	input[type="date"]:focus {
		outline: none;
		border-color: var(--border-strong);
	}

	input.invalid,
	input.invalid:focus {
		border-color: var(--danger-border);
	}

	.audio-pin-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.link-btn {
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 0.8rem;
		cursor: pointer;
		text-decoration: underline;
		padding: 0;
	}

	.link-btn:hover {
		color: var(--text);
	}

	input[type="range"] {
		width: 100%;
		accent-color: var(--primary);
	}

	.helper {
		font-size: 0.75rem;
		color: var(--text-subtle);
	}

	.steps-preview {
		font-size: 0.8rem;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.field-error {
		font-size: 0.8rem;
		color: var(--danger-soft);
	}

	/* Colors come from the global .btn-primary recipe; this only adds layout. */
	.save-btn {
		align-self: flex-start;
	}

	.save-status {
		font-size: 0.85rem;
		font-weight: 600;
	}

	.save-status.success {
		color: var(--success);
	}

	.save-status.error {
		color: var(--danger-soft);
	}

	/* Danger zone: a bordered card of its own, with destructive actions kept apart —
	   Reset stays an outline .btn-danger, Delete is the solid filled one. */
	.danger-zone {
		margin-top: 3rem;
		padding: 1.25rem;
		border: 1px solid var(--danger-border);
		border-radius: var(--r-lg);
	}

	.danger-zone h2 {
		font-size: 1rem;
		color: var(--danger-soft);
		margin: 0 0 1.25rem;
	}

	.danger-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.danger-item + .danger-item {
		margin-top: 1.25rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--border-muted);
	}

	.danger-item p {
		margin: 0.25rem 0 0;
	}

	/* Colors come from the global .btn-danger recipe; this only adds layout. */
	.reset-btn {
		white-space: nowrap;
	}

	.delete-btn {
		padding: 0.55rem 1.1rem;
		background: var(--danger);
		color: var(--text-on-primary);
		border: 1px solid transparent;
		border-radius: var(--r-md);
		font-size: 0.95rem;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
		white-space: nowrap;
		touch-action: manipulation;
		transition: background var(--t-fast) var(--ease);
	}

	.delete-btn:hover:not(:disabled) {
		background: var(--danger-hover);
	}

	.delete-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
</style>

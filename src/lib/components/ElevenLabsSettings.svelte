<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t } from '$lib/i18n';
	import Spinner from './Spinner.svelte';
	import SavedFlag from './SavedFlag.svelte';
	import { SavedFlags } from '$lib/client/saved-flags.svelte';
	import {
		DEFAULT_VOICE_SETTINGS,
		ELEVENLABS_TTS_MODELS,
		elevenLabsModelCreditMultiplier,
		type UserVoiceSettings
	} from '$lib/voice';

	interface VoiceOption {
		voiceId: string;
		name: string;
		category: string;
		description: string;
		previewUrl: string | null;
	}

	interface SubscriptionInfo {
		tier: string;
		characterCount: number;
		characterLimit: number;
		charactersRemaining: number;
		nextResetUnix: number | null;
		status: string;
	}

	let {
		settings,
		keyConfigured,
		disabled = false,
		onUpdate
	}: {
		settings: UserVoiceSettings;
		keyConfigured: boolean;
		disabled?: boolean;
		onUpdate: (partial: Partial<UserVoiceSettings>) => Promise<boolean>;
	} = $props();

	let voices = $state<VoiceOption[]>([]);
	let loadingVoices = $state(false);
	let voicesError = $state(false);
	let voiceSearch = $state('');
	let categoryFilter = $state<string | null>(null);

	let subscription = $state<SubscriptionInfo | null>(null);
	let loadingSubscription = $state(false);
	let subscriptionError = $state(false);

	interface BreakdownSection {
		total: number;
		items: { key: string; credits: number }[];
	}
	interface UsageBreakdown {
		periodDays: number;
		product: BreakdownSection | null;
		model: BreakdownSection | null;
	}
	let breakdown = $state<UsageBreakdown | null>(null);
	const hasBreakdown = $derived(
		!!breakdown && (!!breakdown.product?.items.length || !!breakdown.model?.items.length)
	);

	let advancedOpen = $state(false);
	let previewVoiceId = $state<string | null>(null);
	let previewAudio: HTMLAudioElement | null = null;

	// Transient "Saved ✓" confirmations, one per control group (model / voice / tuning).
	const savedFlags = new SavedFlags();
	async function commit(group: 'model' | 'voice' | 'tuning', partial: Partial<UserVoiceSettings>) {
		savedFlags.flash(group, await onUpdate(partial));
	}

	const voiceCategories = $derived.by(() => {
		const set = new Set<string>();
		for (const voice of voices) {
			if (voice.category) set.add(voice.category);
		}
		return [...set];
	});

	const filteredVoices = $derived.by(() => {
		const query = voiceSearch.trim().toLowerCase();
		let base = categoryFilter ? voices.filter((v) => v.category === categoryFilter) : voices;
		if (query) {
			base = base.filter((v) =>
				`${v.name} ${v.category} ${v.description} ${v.voiceId}`.toLowerCase().includes(query)
			);
		}
		// Always surface the currently selected voice first.
		const selected = base.filter((v) => v.voiceId === settings.elevenlabs_voice_id);
		const rest = base.filter((v) => v.voiceId !== settings.elevenlabs_voice_id);
		return [...selected, ...rest];
	});

	const selectedVoiceName = $derived(
		voices.find((v) => v.voiceId === settings.elevenlabs_voice_id)?.name ?? settings.elevenlabs_voice_id
	);

	const creditUsedPct = $derived(
		subscription && subscription.characterLimit > 0
			? Math.min(100, Math.round((subscription.characterCount / subscription.characterLimit) * 100))
			: 0
	);

	async function loadVoices() {
		loadingVoices = true;
		voicesError = false;
		try {
			const res = await fetch('/api/elevenlabs/voices');
			if (!res.ok) throw new Error('failed');
			const data = (await res.json()) as { voices: VoiceOption[] };
			voices = data.voices ?? [];
		} catch {
			voicesError = true;
		} finally {
			loadingVoices = false;
		}
	}

	async function loadSubscription() {
		loadingSubscription = true;
		subscriptionError = false;
		try {
			const res = await fetch('/api/elevenlabs/subscription');
			if (!res.ok) throw new Error('failed');
			subscription = (await res.json()) as SubscriptionInfo;
		} catch {
			subscriptionError = true;
		} finally {
			loadingSubscription = false;
		}
	}

	// Best-effort: the spend breakdown is a nice-to-have, so on any error we simply don't show it.
	async function loadBreakdown() {
		try {
			const res = await fetch('/api/elevenlabs/usage-breakdown');
			if (!res.ok) return;
			breakdown = (await res.json()) as UsageBreakdown;
		} catch {
			/* leave breakdown null — the credit balance above still renders */
		}
	}

	function prettifyKey(key: string): string {
		return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
	}

	// Map ElevenLabs product_type keys to friendly labels; fall back to a prettified key.
	function productLabel(key: string): string {
		const known = $t(`settings.elevenlabs.product.${key}`);
		return known.startsWith('settings.elevenlabs.product.') ? prettifyKey(key) : known;
	}

	// Reuse the model picker's labels (Flash v2.5, v3, …) for the by-model spend rows.
	function modelBreakdownLabel(key: string): string {
		const known = $t(`settings.elevenlabs.model.${key}`);
		return known.startsWith('settings.elevenlabs.model.') ? prettifyKey(key) : known;
	}

	function creditPct(credits: number, total: number): number {
		return total > 0 ? Math.round((credits / total) * 100) : 0;
	}

	// keyConfigured resolves asynchronously in the parent (and can flip to true when the
	// user adds a key live), so load once it becomes available rather than only on mount.
	let loadedForKey = $state(false);
	$effect(() => {
		if (keyConfigured && !loadedForKey) {
			loadedForKey = true;
			loadVoices();
			loadSubscription();
			loadBreakdown();
		}
	});

	onDestroy(() => {
		stopPreview();
	});

	function stopPreview() {
		if (previewAudio) {
			previewAudio.pause();
			previewAudio = null;
		}
		previewVoiceId = null;
	}

	function togglePreview(voice: VoiceOption) {
		if (!voice.previewUrl) return;
		if (previewVoiceId === voice.voiceId) {
			stopPreview();
			return;
		}
		stopPreview();
		const audio = new Audio(voice.previewUrl);
		audio.onended = () => { if (previewVoiceId === voice.voiceId) stopPreview(); };
		audio.play().catch(() => stopPreview());
		previewAudio = audio;
		previewVoiceId = voice.voiceId;
	}

	function selectVoice(voiceId: string) {
		if (voiceId === settings.elevenlabs_voice_id) return;
		void commit('voice', { elevenlabs_voice_id: voiceId });
	}

	function selectModel(modelId: string) {
		if (modelId === settings.elevenlabs_tts_model) return;
		void commit('model', { elevenlabs_tts_model: modelId });
	}

	function modelLabel(id: string): string {
		return $t(`settings.elevenlabs.model.${id}`);
	}
	function modelDesc(id: string): string {
		return $t(`settings.elevenlabs.model.${id}.desc`);
	}
	function creditBadge(id: string): string {
		return elevenLabsModelCreditMultiplier(id) < 1
			? $t('settings.elevenlabs.halfCredits')
			: $t('settings.elevenlabs.fullCredits');
	}

	function resetTuning() {
		void commit('tuning', {
			elevenlabs_tts_speed: DEFAULT_VOICE_SETTINGS.elevenlabs_tts_speed,
			elevenlabs_stability: DEFAULT_VOICE_SETTINGS.elevenlabs_stability,
			elevenlabs_similarity: DEFAULT_VOICE_SETTINGS.elevenlabs_similarity,
			elevenlabs_style: DEFAULT_VOICE_SETTINGS.elevenlabs_style,
			elevenlabs_speaker_boost: DEFAULT_VOICE_SETTINGS.elevenlabs_speaker_boost
		});
	}

	function commitNumber(field: keyof UserVoiceSettings, event: Event) {
		const value = parseFloat((event.currentTarget as HTMLInputElement).value);
		void commit('tuning', { [field]: value } as Partial<UserVoiceSettings>);
	}

	function formatResetDate(unix: number | null): string {
		if (!unix) return '—';
		return new Date(unix * 1000).toLocaleDateString();
	}
</script>

{#snippet breakdownRows(heading: string, section: BreakdownSection, label: (key: string) => string)}
	<div class="el-breakdown-group">
		<span class="el-breakdown-sub">{heading}</span>
		{#each section.items as item (item.key)}
			<div class="el-breakdown-row">
				<span class="el-breakdown-label">{label(item.key)}</span>
				<span class="el-breakdown-bar" aria-hidden="true">
					<span class="el-breakdown-fill" style={`width:${creditPct(item.credits, section.total)}%`}></span>
				</span>
				<span class="el-breakdown-val">{item.credits.toLocaleString()}</span>
			</div>
		{/each}
	</div>
{/snippet}

{#if !keyConfigured}
	<p class="el-hint">{$t('settings.elevenlabs.needKey')}</p>
{:else}
	<!-- Credit gauge -->
	<div class="el-card">
		<div class="el-card-head">
			<span class="el-card-title">{$t('settings.elevenlabs.credits')}</span>
			{#if subscription}
				<span class="badge el-tier">{subscription.tier}</span>
			{/if}
		</div>
		{#if loadingSubscription}
			<div class="el-center"><Spinner size={18} /></div>
		{:else if subscriptionError || !subscription}
			<p class="el-muted">{$t('settings.elevenlabs.creditsError')}</p>
		{:else}
			<div class="el-credit-bar" role="progressbar" aria-valuenow={creditUsedPct} aria-valuemin={0} aria-valuemax={100}>
				<div class="el-credit-fill" class:el-credit-fill--high={creditUsedPct >= 90} style={`width:${creditUsedPct}%`}></div>
			</div>
			<div class="el-credit-stats">
				<span>{$t('settings.elevenlabs.creditsUsed', {
					used: subscription.characterCount.toLocaleString(),
					limit: subscription.characterLimit.toLocaleString()
				})}</span>
				<span class="el-credit-pct" class:el-credit-pct--high={creditUsedPct >= 90}>{creditUsedPct}%</span>
			</div>
			<p class="el-muted el-reset-note">{$t('settings.elevenlabs.creditsReset', { date: formatResetDate(subscription.nextResetUnix) })}</p>
		{/if}

		{#if hasBreakdown && breakdown}
			<div class="el-breakdown">
				<span class="el-breakdown-title">{$t('settings.elevenlabs.spentTitle', { days: breakdown.periodDays })}</span>
				{#if breakdown.product?.items.length}
					{@render breakdownRows($t('settings.elevenlabs.spentByProduct'), breakdown.product, productLabel)}
				{/if}
				{#if breakdown.model?.items.length}
					{@render breakdownRows($t('settings.elevenlabs.spentByModel'), breakdown.model, modelBreakdownLabel)}
				{/if}
			</div>
		{/if}
	</div>

	<!-- Model / version picker -->
	<div class="el-group">
		<span class="el-group-title">{$t('settings.elevenlabs.model')} <SavedFlag status={savedFlags.get('model')} /></span>
		<span class="el-group-desc">{$t('settings.elevenlabs.modelDesc')}</span>
		<div class="el-model-options">
			{#each ELEVENLABS_TTS_MODELS as model}
				<label class="el-model" class:active={settings.elevenlabs_tts_model === model.id}>
					<input
						type="radio"
						name="elevenlabs-model"
						value={model.id}
						checked={settings.elevenlabs_tts_model === model.id}
						{disabled}
						onchange={() => selectModel(model.id)}
					/>
					<span class="el-model-body">
						<span class="el-model-head">
							<strong>{modelLabel(model.id)}</strong>
							<span class="badge" class:badge--success={model.creditMultiplier < 1}>{creditBadge(model.id)}</span>
						</span>
						<small>{modelDesc(model.id)}</small>
					</span>
				</label>
			{/each}
		</div>
	</div>

	<!-- Voice picker -->
	<div class="el-group">
		<span class="el-group-title">{$t('settings.elevenlabs.voice')} <SavedFlag status={savedFlags.get('voice')} /></span>
		<span class="el-group-desc">{$t('settings.elevenlabs.voiceDesc', { name: selectedVoiceName })}</span>

		{#if loadingVoices}
			<div class="el-center"><Spinner size={18} /></div>
		{:else if voicesError}
			<p class="el-muted">
				{$t('settings.elevenlabs.voicesError')}
				<button type="button" class="el-link-btn" onclick={loadVoices}>{$t('settings.elevenlabs.retry')}</button>
			</p>
		{:else}
			<input
				class="el-search"
				type="search"
				placeholder={$t('settings.elevenlabs.searchVoices')}
				bind:value={voiceSearch}
			/>
			{#if voiceCategories.length > 1}
				<div class="el-cat-row" role="group" aria-label={$t('settings.elevenlabs.categoryFilter')}>
					<button
						type="button"
						class="el-cat"
						class:active={categoryFilter === null}
						aria-pressed={categoryFilter === null}
						onclick={() => (categoryFilter = null)}
					>
						{$t('settings.elevenlabs.allCategories')}
					</button>
					{#each voiceCategories as category (category)}
						<button
							type="button"
							class="el-cat"
							class:active={categoryFilter === category}
							aria-pressed={categoryFilter === category}
							onclick={() => (categoryFilter = categoryFilter === category ? null : category)}
						>
							{category}
						</button>
					{/each}
				</div>
			{/if}
			<div class="el-voice-list">
				{#each filteredVoices as voice (voice.voiceId)}
					<div class="el-voice" class:active={settings.elevenlabs_voice_id === voice.voiceId}>
						<label class="el-voice-select">
							<input
								type="radio"
								name="elevenlabs-voice"
								value={voice.voiceId}
								checked={settings.elevenlabs_voice_id === voice.voiceId}
								{disabled}
								onchange={() => selectVoice(voice.voiceId)}
							/>
							<span class="el-voice-info">
								<span class="el-voice-head">
									<span class="el-voice-name">{voice.name}</span>
									{#if voice.category}<span class="badge el-voice-cat">{voice.category}</span>{/if}
								</span>
								{#if voice.description}<span class="el-voice-desc">{voice.description}</span>{/if}
							</span>
						</label>
						{#if voice.previewUrl}
							<button
								type="button"
								class="el-preview-btn"
								class:playing={previewVoiceId === voice.voiceId}
								aria-label={previewVoiceId === voice.voiceId ? $t('settings.elevenlabs.previewStop') : $t('settings.elevenlabs.preview')}
								aria-pressed={previewVoiceId === voice.voiceId}
								onclick={() => togglePreview(voice)}
							>
								{#if previewVoiceId === voice.voiceId}
									<span class="el-eq" aria-hidden="true"><span></span><span></span><span></span></span>
									{$t('settings.elevenlabs.previewStop')}
								{:else}
									<span class="el-play-glyph" aria-hidden="true">▶</span>
									{$t('settings.elevenlabs.previewBtn')}
								{/if}
							</button>
						{/if}
					</div>
				{/each}
				{#if filteredVoices.length === 0}
					<p class="el-muted el-empty">{$t('settings.elevenlabs.noVoices')}</p>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Advanced tuning -->
	<div class="el-group">
		<button type="button" class="el-advanced-toggle" onclick={() => (advancedOpen = !advancedOpen)} aria-expanded={advancedOpen}>
			<span class="el-group-title">{$t('settings.elevenlabs.tuning')} <SavedFlag status={savedFlags.get('tuning')} /></span>
			<span class="el-chevron">{advancedOpen ? '−' : '+'}</span>
		</button>
		{#if advancedOpen}
			<div class="el-tuning">
				<label class="el-slider">
					<span class="el-slider-head">
						<span>{$t('settings.elevenlabs.speed')}</span>
						<span class="el-slider-val">{settings.elevenlabs_tts_speed.toFixed(2)}×</span>
					</span>
					<input type="range" min="0.7" max="1.2" step="0.05" value={settings.elevenlabs_tts_speed} {disabled}
						onchange={(e) => commitNumber('elevenlabs_tts_speed', e)} />
				</label>
				<label class="el-slider">
					<span class="el-slider-head">
						<span>{$t('settings.elevenlabs.stability')}</span>
						<span class="el-slider-val">{Math.round(settings.elevenlabs_stability * 100)}%</span>
					</span>
					<input type="range" min="0" max="1" step="0.05" value={settings.elevenlabs_stability} {disabled}
						onchange={(e) => commitNumber('elevenlabs_stability', e)} />
					<small>{$t('settings.elevenlabs.stabilityDesc')}</small>
				</label>
				<label class="el-slider">
					<span class="el-slider-head">
						<span>{$t('settings.elevenlabs.similarity')}</span>
						<span class="el-slider-val">{Math.round(settings.elevenlabs_similarity * 100)}%</span>
					</span>
					<input type="range" min="0" max="1" step="0.05" value={settings.elevenlabs_similarity} {disabled}
						onchange={(e) => commitNumber('elevenlabs_similarity', e)} />
					<small>{$t('settings.elevenlabs.similarityDesc')}</small>
				</label>
				<label class="el-slider">
					<span class="el-slider-head">
						<span>{$t('settings.elevenlabs.style')}</span>
						<span class="el-slider-val">{Math.round(settings.elevenlabs_style * 100)}%</span>
					</span>
					<input type="range" min="0" max="1" step="0.05" value={settings.elevenlabs_style} {disabled}
						onchange={(e) => commitNumber('elevenlabs_style', e)} />
					<small>{$t('settings.elevenlabs.styleDesc')}</small>
				</label>
				<label class="el-toggle-row">
					<span>
						<span class="el-toggle-title">{$t('settings.elevenlabs.speakerBoost')}</span>
						<small>{$t('settings.elevenlabs.speakerBoostDesc')}</small>
					</span>
					<input type="checkbox" role="switch" checked={settings.elevenlabs_speaker_boost} {disabled}
						onchange={(e) => commit('tuning', { elevenlabs_speaker_boost: (e.currentTarget as HTMLInputElement).checked })} />
				</label>
				<button type="button" class="el-reset" onclick={resetTuning} {disabled}>{$t('settings.elevenlabs.resetTuning')}</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.el-hint {
		font-size: 0.85rem;
		color: var(--text-muted);
		background: var(--surface-2);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-md);
		padding: 0.7rem 0.85rem;
		margin: 0 0 1rem;
		line-height: 1.45;
	}

	/* Credit gauge — the most premium surface in the app, so give it presence. */
	.el-card {
		background: var(--surface-2);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-md);
		padding: 0.95rem 1rem;
		margin-bottom: 1rem;
	}

	.el-card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.7rem;
	}

	.el-card-title {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--text);
	}

	.el-tier {
		text-transform: capitalize;
	}

	.el-credit-bar {
		height: 10px;
		border-radius: var(--r-pill);
		background: var(--border-muted);
		overflow: hidden;
	}

	.el-credit-fill {
		height: 100%;
		border-radius: var(--r-pill);
		background: var(--primary);
		transition: width var(--t-med) var(--ease);
	}

	.el-credit-fill--high {
		background: var(--danger);
	}

	.el-credit-stats {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 0.75rem;
		font-size: 0.82rem;
		color: var(--text-muted);
		margin-top: 0.55rem;
	}

	.el-credit-pct {
		font-size: 1.05rem;
		font-weight: 700;
		color: var(--text);
		font-variant-numeric: tabular-nums;
	}

	.el-credit-pct--high {
		color: var(--danger);
	}

	.el-reset-note {
		margin: 0.35rem 0 0;
	}

	.el-breakdown {
		margin-top: 0.85rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border-muted);
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.el-breakdown-title {
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--text-muted);
	}

	.el-breakdown-group {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.el-breakdown-sub {
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-subtle);
		margin-top: 0.15rem;
	}

	.el-breakdown-row {
		display: grid;
		grid-template-columns: minmax(7rem, auto) 1fr auto;
		align-items: center;
		gap: 0.55rem;
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	.el-breakdown-label {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.el-breakdown-bar {
		height: 6px;
		border-radius: var(--r-pill);
		background: var(--border-muted);
		overflow: hidden;
	}

	.el-breakdown-fill {
		display: block;
		height: 100%;
		background: var(--primary);
	}

	.el-breakdown-val {
		font-variant-numeric: tabular-nums;
		color: var(--text);
		white-space: nowrap;
	}

	.el-group {
		margin-bottom: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.el-group-title {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--text);
	}

	.el-group-desc {
		font-size: 0.82rem;
		line-height: 1.45;
		color: var(--text-subtle);
		margin-bottom: 0.2rem;
	}

	/* Radio-card idiom, matched to the voice-provider cards in settings. */
	.el-model-options {
		display: grid;
		gap: 0.5rem;
	}

	.el-model {
		display: flex;
		align-items: flex-start;
		gap: 0.65rem;
		padding: 0.75rem;
		border: 1px solid var(--border-muted);
		border-radius: var(--r-md);
		cursor: pointer;
		background: var(--surface-2);
		transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
	}

	.el-model:hover {
		border-color: var(--border-strong);
	}

	.el-model.active {
		border-color: var(--primary);
		background: var(--surface-elevated);
	}

	.el-model input {
		margin-top: 0.2rem;
		accent-color: var(--primary);
	}

	.el-model-body {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}

	.el-model-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.el-model-head strong {
		font-size: 0.9rem;
		color: var(--text);
	}

	.el-model-body small {
		font-size: 0.78rem;
		line-height: 1.35;
		color: var(--text-muted);
	}

	.el-search {
		width: 100%;
		padding: 0.5rem 0.7rem;
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--r-sm);
		color: var(--text);
		font-size: 0.88rem;
		box-sizing: border-box;
		transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
	}

	.el-search:focus {
		outline: none;
		border-color: var(--border-strong);
		box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.06);
	}

	/* Category filter pills (All + distinct categories from the loaded voices). */
	.el-cat-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
	}

	.el-cat {
		padding: 0.3rem 0.75rem;
		min-height: 2rem;
		border: 1px solid var(--border);
		border-radius: var(--r-pill);
		background: transparent;
		color: var(--text-muted);
		font-family: inherit;
		font-size: 0.78rem;
		font-weight: 600;
		text-transform: capitalize;
		cursor: pointer;
		touch-action: manipulation;
		transition:
			color var(--t-fast) var(--ease),
			background var(--t-fast) var(--ease),
			border-color var(--t-fast) var(--ease);
	}

	.el-cat:hover {
		color: var(--text);
		border-color: var(--border-strong);
	}

	.el-cat.active {
		background: var(--surface-elevated);
		border-color: var(--primary);
		color: var(--text);
	}

	.el-voice-list {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		max-height: 300px;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}

	.el-voice {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.55rem 0.6rem;
		border: 1px solid var(--border-muted);
		border-radius: var(--r-md);
		background: var(--surface-2);
		transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
	}

	.el-voice:hover {
		border-color: var(--border-strong);
	}

	.el-voice.active {
		border-color: var(--primary);
		background: var(--surface-elevated);
	}

	.el-voice-select {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex: 1;
		min-width: 0;
		cursor: pointer;
	}

	.el-voice-select input {
		accent-color: var(--primary);
		flex-shrink: 0;
	}

	.el-voice-info {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}

	.el-voice-head {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		min-width: 0;
	}

	.el-voice-name {
		font-size: 0.88rem;
		color: var(--text);
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.el-voice-cat {
		font-size: 0.62rem;
		padding: 0.1rem 0.45rem;
		text-transform: capitalize;
		flex-shrink: 0;
	}

	.el-voice-desc {
		font-size: 0.74rem;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Labeled preview control; while playing the glyph becomes a 3-bar equalizer. */
	.el-preview-btn {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		min-height: 2.25rem;
		padding: 0 0.7rem;
		border-radius: var(--r-sm);
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text-muted);
		cursor: pointer;
		font-family: inherit;
		font-size: 0.75rem;
		font-weight: 600;
		touch-action: manipulation;
		transition:
			color var(--t-fast) var(--ease),
			border-color var(--t-fast) var(--ease),
			background var(--t-fast) var(--ease);
	}

	.el-preview-btn:hover {
		color: var(--text);
		border-color: var(--border-strong);
	}

	.el-preview-btn.playing {
		border-color: var(--primary);
		background: var(--surface-elevated);
		color: var(--text);
	}

	.el-play-glyph {
		font-size: 0.6rem;
		line-height: 1;
	}

	.el-eq {
		display: inline-flex;
		align-items: flex-end;
		gap: 2px;
		height: 12px;
	}

	.el-eq span {
		width: 3px;
		border-radius: 1px;
		background: currentColor;
		transform-origin: bottom;
		animation: el-eq-bounce 0.9s ease-in-out infinite;
	}

	.el-eq span:nth-child(1) {
		height: 8px;
	}

	.el-eq span:nth-child(2) {
		height: 12px;
		animation-delay: 0.15s;
	}

	.el-eq span:nth-child(3) {
		height: 9px;
		animation-delay: 0.3s;
	}

	@keyframes el-eq-bounce {
		0%, 100% { transform: scaleY(0.45); }
		50% { transform: scaleY(1); }
	}

	.el-empty {
		text-align: center;
		padding: 0.75rem 0;
	}

	.el-advanced-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		min-height: 44px;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		color: inherit;
		font-family: inherit;
		touch-action: manipulation;
	}

	.el-chevron {
		font-size: 1.2rem;
		color: var(--text-muted);
		line-height: 1;
	}

	.el-tuning {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		margin-top: 0.5rem;
	}

	.el-slider {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
	}

	.el-slider-head {
		display: flex;
		justify-content: space-between;
		font-size: 0.85rem;
		color: var(--text);
		font-weight: 600;
	}

	.el-slider-val {
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.el-slider input[type='range'] {
		width: 100%;
		accent-color: var(--primary);
	}

	.el-slider small {
		font-size: 0.74rem;
		color: var(--text-subtle);
		line-height: 1.35;
	}

	.el-toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.el-toggle-row span {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		min-width: 0;
	}

	.el-toggle-title {
		font-size: 0.88rem;
		font-weight: 600;
		color: var(--text);
	}

	.el-toggle-row small {
		font-size: 0.74rem;
		color: var(--text-subtle);
		line-height: 1.35;
	}

	.el-toggle-row input {
		width: 2.7rem;
		height: 1.5rem;
		flex-shrink: 0;
		accent-color: var(--primary);
		cursor: pointer;
	}

	.el-reset {
		align-self: flex-start;
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text-muted);
		border-radius: var(--r-sm);
		padding: 0.4rem 0.9rem;
		font-family: inherit;
		font-size: 0.82rem;
		cursor: pointer;
		font-weight: 600;
		touch-action: manipulation;
	}

	.el-reset:hover:not(:disabled) {
		border-color: var(--border-strong);
		color: var(--text);
	}

	.el-center {
		display: flex;
		justify-content: center;
		padding: 0.75rem 0;
		color: var(--text-muted);
	}

	.el-muted {
		font-size: 0.82rem;
		color: var(--text-subtle);
		margin: 0;
	}

	.el-link-btn {
		background: none;
		border: none;
		color: var(--text);
		text-decoration: underline;
		cursor: pointer;
		font-size: 0.82rem;
		padding: 0;
	}
</style>

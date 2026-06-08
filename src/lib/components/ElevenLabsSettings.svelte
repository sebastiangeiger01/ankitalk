<script lang="ts">
	import { onDestroy } from 'svelte';
	import { t } from '$lib/i18n';
	import Spinner from './Spinner.svelte';
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
		onUpdate: (partial: Partial<UserVoiceSettings>) => void;
	} = $props();

	let voices = $state<VoiceOption[]>([]);
	let loadingVoices = $state(false);
	let voicesError = $state(false);
	let voiceSearch = $state('');

	let subscription = $state<SubscriptionInfo | null>(null);
	let loadingSubscription = $state(false);
	let subscriptionError = $state(false);

	let advancedOpen = $state(false);
	let previewVoiceId = $state<string | null>(null);
	let previewAudio: HTMLAudioElement | null = null;

	const filteredVoices = $derived.by(() => {
		const query = voiceSearch.trim().toLowerCase();
		const base = query
			? voices.filter((v) =>
					`${v.name} ${v.category} ${v.description} ${v.voiceId}`.toLowerCase().includes(query)
				)
			: voices;
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

	// keyConfigured resolves asynchronously in the parent (and can flip to true when the
	// user adds a key live), so load once it becomes available rather than only on mount.
	let loadedForKey = $state(false);
	$effect(() => {
		if (keyConfigured && !loadedForKey) {
			loadedForKey = true;
			loadVoices();
			loadSubscription();
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
		onUpdate({ elevenlabs_voice_id: voiceId });
	}

	function selectModel(modelId: string) {
		if (modelId === settings.elevenlabs_tts_model) return;
		onUpdate({ elevenlabs_tts_model: modelId });
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
		onUpdate({
			elevenlabs_tts_speed: DEFAULT_VOICE_SETTINGS.elevenlabs_tts_speed,
			elevenlabs_stability: DEFAULT_VOICE_SETTINGS.elevenlabs_stability,
			elevenlabs_similarity: DEFAULT_VOICE_SETTINGS.elevenlabs_similarity,
			elevenlabs_style: DEFAULT_VOICE_SETTINGS.elevenlabs_style,
			elevenlabs_speaker_boost: DEFAULT_VOICE_SETTINGS.elevenlabs_speaker_boost
		});
	}

	function commitNumber(field: keyof UserVoiceSettings, event: Event) {
		const value = parseFloat((event.currentTarget as HTMLInputElement).value);
		onUpdate({ [field]: value } as Partial<UserVoiceSettings>);
	}

	function formatResetDate(unix: number | null): string {
		if (!unix) return '—';
		return new Date(unix * 1000).toLocaleDateString();
	}
</script>

{#if !keyConfigured}
	<p class="el-hint">{$t('settings.elevenlabs.needKey')}</p>
{:else}
	<!-- Credit balance -->
	<div class="el-card">
		<div class="el-card-head">
			<span class="el-card-title">{$t('settings.elevenlabs.credits')}</span>
			{#if subscription}
				<span class="el-tier">{subscription.tier}</span>
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
				<span>{creditUsedPct}%</span>
			</div>
			<p class="el-muted el-reset">{$t('settings.elevenlabs.creditsReset', { date: formatResetDate(subscription.nextResetUnix) })}</p>
		{/if}
	</div>

	<!-- Model / version picker -->
	<div class="el-group">
		<span class="el-group-title">{$t('settings.elevenlabs.model')}</span>
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
							<span class="el-badge" class:el-badge--cheap={model.creditMultiplier < 1}>{creditBadge(model.id)}</span>
						</span>
						<small>{modelDesc(model.id)}</small>
					</span>
				</label>
			{/each}
		</div>
	</div>

	<!-- Voice picker -->
	<div class="el-group">
		<span class="el-group-title">{$t('settings.elevenlabs.voice')}</span>
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
								<span class="el-voice-name">{voice.name}</span>
								{#if voice.description}<span class="el-voice-desc">{voice.description}</span>{/if}
							</span>
						</label>
						{#if voice.previewUrl}
							<button
								type="button"
								class="el-preview-btn"
								class:playing={previewVoiceId === voice.voiceId}
								aria-label={$t('settings.elevenlabs.preview')}
								onclick={() => togglePreview(voice)}
							>
								{previewVoiceId === voice.voiceId ? '■' : '▶'}
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
			<span class="el-group-title">{$t('settings.elevenlabs.tuning')}</span>
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
						onchange={(e) => onUpdate({ elevenlabs_speaker_boost: (e.currentTarget as HTMLInputElement).checked })} />
				</label>
				<button type="button" class="el-reset" onclick={resetTuning} {disabled}>{$t('settings.elevenlabs.resetTuning')}</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.el-hint {
		font-size: 0.85rem;
		color: #8d8db0;
		background: #17172a;
		border: 1px solid #2e2e52;
		border-radius: 8px;
		padding: 0.7rem 0.85rem;
		margin: 0;
		line-height: 1.45;
	}

	.el-card {
		background: #17172a;
		border: 1px solid #2e2e52;
		border-radius: 10px;
		padding: 0.85rem 1rem;
		margin-bottom: 0.75rem;
	}

	.el-card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.6rem;
	}

	.el-card-title {
		font-size: 0.9rem;
		font-weight: 600;
		color: #dadaff;
	}

	.el-tier {
		font-size: 0.72rem;
		font-weight: 600;
		text-transform: capitalize;
		padding: 0.15rem 0.55rem;
		border-radius: 99px;
		background: #2a2a4a;
		color: #b0b0e0;
	}

	.el-credit-bar {
		height: 8px;
		border-radius: 99px;
		background: #2a2a4a;
		overflow: hidden;
	}

	.el-credit-fill {
		height: 100%;
		background: #6b6bc8;
		transition: width 0.3s;
	}

	.el-credit-fill--high {
		background: #c87070;
	}

	.el-credit-stats {
		display: flex;
		justify-content: space-between;
		font-size: 0.82rem;
		color: #a0a0c0;
		margin-top: 0.5rem;
	}

	.el-reset {
		margin: 0.35rem 0 0;
	}

	.el-group {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 10px;
		padding: 0.9rem 1rem;
		margin-bottom: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.el-group-title {
		font-size: 0.95rem;
		font-weight: 600;
		color: #d0d0f0;
	}

	.el-group-desc {
		font-size: 0.82rem;
		line-height: 1.45;
		color: #7a7a9a;
		margin-bottom: 0.2rem;
	}

	.el-model-options {
		display: grid;
		gap: 0.5rem;
	}

	.el-model {
		display: flex;
		align-items: flex-start;
		gap: 0.65rem;
		padding: 0.7rem;
		border: 1px solid #2e2e52;
		border-radius: 8px;
		cursor: pointer;
		background: #17172a;
	}

	.el-model.active {
		border-color: #6666b8;
		background: #202045;
	}

	.el-model input {
		margin-top: 0.2rem;
		accent-color: #8b8bea;
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
		color: #dadaff;
	}

	.el-model-body small {
		font-size: 0.78rem;
		line-height: 1.35;
		color: #8d8db0;
	}

	.el-badge {
		font-size: 0.68rem;
		font-weight: 600;
		padding: 0.1rem 0.45rem;
		border-radius: 99px;
		background: #2a2a4a;
		color: #9a9ac0;
		white-space: nowrap;
	}

	.el-badge--cheap {
		background: #1a3a2a;
		color: #5aba84;
	}

	.el-search {
		width: 100%;
		padding: 0.5rem 0.7rem;
		background: #12121f;
		border: 1px solid #3a3a5e;
		border-radius: 7px;
		color: #e0e0ff;
		font-size: 0.88rem;
		box-sizing: border-box;
	}

	.el-search:focus {
		outline: none;
		border-color: #5a5a9e;
	}

	.el-voice-list {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		max-height: 260px;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
	}

	.el-voice {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.6rem;
		border: 1px solid #2e2e52;
		border-radius: 8px;
		background: #17172a;
	}

	.el-voice.active {
		border-color: #6666b8;
		background: #202045;
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
		accent-color: #8b8bea;
		flex-shrink: 0;
	}

	.el-voice-info {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		min-width: 0;
	}

	.el-voice-name {
		font-size: 0.88rem;
		color: #dadaff;
		font-weight: 600;
	}

	.el-voice-desc {
		font-size: 0.74rem;
		color: #8d8db0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.el-preview-btn {
		flex-shrink: 0;
		width: 2rem;
		height: 2rem;
		border-radius: 6px;
		border: 1px solid #3a3a5e;
		background: #22223a;
		color: #b0b0e0;
		cursor: pointer;
		font-size: 0.7rem;
		display: flex;
		align-items: center;
		justify-content: center;
		touch-action: manipulation;
	}

	.el-preview-btn.playing {
		border-color: #6666b8;
		background: #303060;
		color: #f0f0ff;
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
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		color: inherit;
	}

	.el-chevron {
		font-size: 1.2rem;
		color: #8d8db0;
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
		color: #c0c0e0;
		font-weight: 600;
	}

	.el-slider-val {
		color: #8b8bea;
	}

	.el-slider input[type='range'] {
		width: 100%;
		accent-color: #6b6bc8;
	}

	.el-slider small {
		font-size: 0.74rem;
		color: #7a7a9a;
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
		color: #d0d0f0;
	}

	.el-toggle-row small {
		font-size: 0.74rem;
		color: #7a7a9a;
		line-height: 1.35;
	}

	.el-toggle-row input {
		width: 2.7rem;
		height: 1.5rem;
		flex-shrink: 0;
		accent-color: #6b6bc8;
		cursor: pointer;
	}

	.el-reset {
		align-self: flex-start;
		background: #22223a;
		border: 1px solid #3a3a5e;
		color: #a8a8c8;
		border-radius: 7px;
		padding: 0.4rem 0.9rem;
		font-size: 0.82rem;
		cursor: pointer;
		font-weight: 600;
	}

	.el-reset:hover:not(:disabled) {
		border-color: #5a5a8e;
		color: #e0e0ff;
	}

	.el-center {
		display: flex;
		justify-content: center;
		padding: 0.75rem 0;
		color: #8080c0;
	}

	.el-muted {
		font-size: 0.82rem;
		color: #7a7a9a;
		margin: 0;
	}

	.el-link-btn {
		background: none;
		border: none;
		color: #7a7aaa;
		text-decoration: underline;
		cursor: pointer;
		font-size: 0.82rem;
		padding: 0;
	}
</style>

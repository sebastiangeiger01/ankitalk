<script lang="ts">
	import { onMount } from 'svelte';
	import { getPrepareAudioAhead, setPrepareAudioAhead } from '$lib/client/preferences';
	import { locale, t, type Locale } from '$lib/i18n';
	import Spinner from '$lib/components/Spinner.svelte';
	import ElevenLabsSettings from '$lib/components/ElevenLabsSettings.svelte';
	import type { UserVoiceSettings, VoiceCommandLanguage, VoiceProvider } from '$lib/voice';

	function setLocale(l: Locale) {
		locale.set(l);
	}

	let current = $state<Locale>('en');
	let prepareAudioAhead = $state(true);
	$effect(() => {
		return locale.subscribe((v) => { current = v; });
	});

	// --- API key state ---
	type Service = 'openai' | 'deepgram' | 'anthropic' | 'elevenlabs';

	interface KeyStatus {
		openai: boolean;
		deepgram: boolean;
		anthropic: boolean;
		elevenlabs: boolean;
	}

	interface UsagePeriod {
		openai: number;
		deepgram: number;
		anthropic: number;
		elevenlabs: number;
		total: number;
	}

	interface UsageData {
		today: UsagePeriod;
		week: UsagePeriod;
		month: UsagePeriod;
	}

	let keyStatus = $state<KeyStatus>({ openai: false, deepgram: false, anthropic: false, elevenlabs: false });
	let keyInputs = $state<Record<Service, string>>({ openai: '', deepgram: '', anthropic: '', elevenlabs: '' });
	let expanded = $state<Record<Service, boolean>>({ openai: false, deepgram: false, anthropic: false, elevenlabs: false });
	let saving = $state<Record<Service, boolean>>({ openai: false, deepgram: false, anthropic: false, elevenlabs: false });
	let removing = $state<Record<Service, boolean>>({ openai: false, deepgram: false, anthropic: false, elevenlabs: false });
	let messages = $state<Record<Service, { text: string; ok: boolean } | null>>({
		openai: null,
		deepgram: null,
		anthropic: null,
		elevenlabs: null,
	});
	let voiceSettings = $state<UserVoiceSettings>({
		voice_provider: 'elevenlabs',
		voice_command_language: 'en',
		elevenlabs_voice_id: 'JBFqnCBsd6RMkjVDRZzb',
		elevenlabs_tts_model: 'eleven_flash_v2_5',
		elevenlabs_stt_model: 'scribe_v2_realtime',
		elevenlabs_tts_speed: 1.0,
		elevenlabs_stability: 0.5,
		elevenlabs_similarity: 0.75,
		elevenlabs_style: 0.0,
		elevenlabs_speaker_boost: true
	});
	let savingVoiceSettings = $state(false);
	let voiceSettingsMessage = $state<{ text: string; ok: boolean } | null>(null);

	let usageData = $state<UsageData | null>(null);
	let loadingUsage = $state(false);

	const serviceLinks: Record<Service, string> = {
		openai: 'platform.openai.com/api-keys',
		deepgram: 'console.deepgram.com',
		anthropic: 'console.anthropic.com/settings/keys',
		elevenlabs: 'elevenlabs.io/app/settings/api-keys',
	};

	const serviceHrefs: Record<Service, string> = {
		openai: 'https://platform.openai.com/api-keys',
		deepgram: 'https://console.deepgram.com',
		anthropic: 'https://console.anthropic.com/settings/keys',
		elevenlabs: 'https://elevenlabs.io/app/settings/api-keys',
	};

	onMount(async () => {
		prepareAudioAhead = getPrepareAudioAhead();

		try {
			const res = await fetch('/api/settings/api-keys');
			if (res.ok) {
				const data = await res.json() as KeyStatus;
				keyStatus = data;
			}
		} catch {
			// silently ignore — keys stay as not configured
		}

		try {
			const res = await fetch(`/api/settings/voice?locale=${encodeURIComponent(current)}`);
			if (res.ok) {
				const data = await res.json() as { settings: UserVoiceSettings };
				voiceSettings = data.settings;
			}
		} catch {
			// defaults stay active
		}

		loadingUsage = true;
		try {
			const res = await fetch('/api/settings/usage');
			if (res.ok) {
				usageData = await res.json() as UsageData;
			}
		} catch {
			// silently ignore
		} finally {
			loadingUsage = false;
		}
	});

	function toggleExpanded(service: Service) {
		expanded[service] = !expanded[service];
		if (!expanded[service]) {
			keyInputs[service] = '';
			messages[service] = null;
		}
	}

	function updatePrepareAudioAhead(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		prepareAudioAhead = input.checked;
		setPrepareAudioAhead(input.checked);
	}

	async function saveVoiceSettings(nextSettings: UserVoiceSettings, previousSettings: UserVoiceSettings) {
		voiceSettings = nextSettings;
		savingVoiceSettings = true;
		voiceSettingsMessage = null;
		try {
			const res = await fetch('/api/settings/voice', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(nextSettings)
			});
			if (res.ok) {
				const data = await res.json() as { settings: UserVoiceSettings };
				voiceSettings = data.settings;
				voiceSettingsMessage = { text: t('settings.voice.saved'), ok: true };
				setTimeout(() => { voiceSettingsMessage = null; }, 2000);
			} else {
				throw new Error('Failed to save voice settings');
			}
		} catch {
			voiceSettings = previousSettings;
			voiceSettingsMessage = { text: t('settings.voice.saveFailed'), ok: false };
		} finally {
			savingVoiceSettings = false;
		}
	}

	async function updateVoiceProvider(provider: VoiceProvider) {
		if (voiceSettings.voice_provider === provider) return;
		const previous = { ...voiceSettings };
		await saveVoiceSettings(
			{ ...voiceSettings, voice_provider: provider },
			previous
		);
	}

	async function updateElevenLabsSettings(partial: Partial<UserVoiceSettings>) {
		const previous = { ...voiceSettings };
		await saveVoiceSettings({ ...voiceSettings, ...partial }, previous);
	}

	async function updateVoiceCommandLanguage(language: VoiceCommandLanguage) {
		if (voiceSettings.voice_command_language === language) return;
		const previous = { ...voiceSettings };
		await saveVoiceSettings(
			{ ...voiceSettings, voice_command_language: language },
			previous
		);
	}

	async function saveKey(service: Service) {
		const key = keyInputs[service].trim();
		if (!key) return;
		saving[service] = true;
		messages[service] = null;
		try {
			const res = await fetch('/api/settings/api-keys', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ service, key }),
			});
			if (res.ok) {
				keyStatus[service] = true;
				keyInputs[service] = '';
				expanded[service] = false;
				messages[service] = { text: t('settings.apiKeys.saved'), ok: true };
			} else {
				const errKey = res.status === 429
					? 'settings.apiKeys.rateLimited'
					: res.status === 403 && service === 'deepgram'
						? 'settings.apiKeys.deepgramPermissions'
						: res.status === 403 && service === 'elevenlabs'
							? 'settings.apiKeys.elevenlabsPermissions'
							: 'settings.apiKeys.invalid';
				messages[service] = { text: t(errKey), ok: false };
			}
		} catch {
			messages[service] = { text: t('settings.apiKeys.invalid'), ok: false };
		} finally {
			saving[service] = false;
		}
	}

	async function removeKey(service: Service) {
		removing[service] = true;
		messages[service] = null;
		try {
			const res = await fetch('/api/settings/api-keys', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ service }),
			});
			if (res.ok) {
				keyStatus[service] = false;
				messages[service] = { text: t('settings.apiKeys.removed'), ok: true };
			}
		} catch {
			// silently ignore
		} finally {
			removing[service] = false;
		}
	}

	function formatCost(n: number): string {
		if (n === 0) return '$0.00';
		if (n < 0.01) return '<$0.01';
		return '$' + n.toFixed(2);
	}

	function allZero(usage: UsageData): boolean {
		return usage.today.total === 0 && usage.week.total === 0 && usage.month.total === 0;
	}

	const primaryServices: Service[] = ['elevenlabs'];
	const advancedServices: Service[] = ['openai', 'deepgram', 'anthropic'];
	const usageServices: Service[] = ['elevenlabs', 'openai', 'deepgram', 'anthropic'];
	const voiceCommandLanguages: VoiceCommandLanguage[] = ['auto', 'en', 'de'];

	function serviceLabel(s: Service): string {
		return t(`settings.apiKeys.${s}`);
	}
	function serviceDesc(s: Service): string {
		return t(`settings.apiKeys.${s}Desc`);
	}
	function serviceCost(s: Service): string {
		return t(`settings.apiKeys.${s}Cost`);
	}
</script>

{#key current}
<div class="settings-page">
	<a href="/" class="back-link">&larr; {t('appSettings.dashboard')}</a>

	<h1>{t('appSettings.title')}</h1>

	<section class="section">
		<h2>{t('appSettings.language')}</h2>
		<div class="lang-options">
			<button class="lang-btn" class:active={current === 'en'} onclick={() => setLocale('en')}>
				English
			</button>
			<button class="lang-btn" class:active={current === 'de'} onclick={() => setLocale('de')}>
				Deutsch
			</button>
		</div>
	</section>

	<section class="section">
		<h2>{t('appSettings.audio')}</h2>
		<div class="voice-provider-group" aria-label={t('settings.voice.title')}>
			<div class="voice-provider-copy">
				<span class="preference-title">{t('settings.voice.title')}</span>
				<span class="preference-desc">{t('settings.voice.desc')}</span>
			</div>
			<div class="provider-options">
				<label class="provider-option" class:active={voiceSettings.voice_provider === 'elevenlabs'}>
					<input
						type="radio"
						name="voice-provider"
						value="elevenlabs"
						checked={voiceSettings.voice_provider === 'elevenlabs'}
						disabled={savingVoiceSettings}
						onchange={() => updateVoiceProvider('elevenlabs')}
					/>
					<span>
						<strong>{t('settings.voice.elevenlabs')}</strong>
						<small>{t('settings.voice.elevenlabsDesc')}</small>
					</span>
				</label>
				<label class="provider-option" class:active={voiceSettings.voice_provider === 'openai_deepgram'}>
					<input
						type="radio"
						name="voice-provider"
						value="openai_deepgram"
						checked={voiceSettings.voice_provider === 'openai_deepgram'}
						disabled={savingVoiceSettings}
						onchange={() => updateVoiceProvider('openai_deepgram')}
					/>
					<span>
						<strong>{t('settings.voice.legacy')}</strong>
						<small>{t('settings.voice.legacyDesc')}</small>
					</span>
				</label>
			</div>
			{#if voiceSettingsMessage}
				<p class="key-message" class:key-message--ok={voiceSettingsMessage.ok} class:key-message--err={!voiceSettingsMessage.ok}>
					{voiceSettingsMessage.text}
				</p>
			{/if}
		</div>

		{#if voiceSettings.voice_provider === 'elevenlabs'}
			<ElevenLabsSettings
				settings={voiceSettings}
				keyConfigured={keyStatus.elevenlabs}
				disabled={savingVoiceSettings}
				onUpdate={updateElevenLabsSettings}
			/>
		{/if}
		<div class="voice-language-group" aria-label={t('settings.voice.commandLanguage')}>
			<div class="voice-provider-copy">
				<span class="preference-title">{t('settings.voice.commandLanguage')}</span>
				<span class="preference-desc">
					{voiceSettings.voice_command_language === 'auto'
						? t('settings.voice.commandLanguageAutoDesc')
						: t('settings.voice.commandLanguageFixedDesc')}
				</span>
			</div>
			<div class="segmented-control">
				{#each voiceCommandLanguages as language}
					<label class="segment-option" class:active={voiceSettings.voice_command_language === language}>
						<input
							type="radio"
							name="voice-command-language"
							value={language}
							checked={voiceSettings.voice_command_language === language}
							disabled={savingVoiceSettings}
							onchange={() => updateVoiceCommandLanguage(language)}
						/>
						<span>{t(`settings.voice.commandLanguage.${language}`)}</span>
					</label>
				{/each}
			</div>
		</div>
		<label class="preference-row">
			<span class="preference-copy">
				<span class="preference-title">{t('appSettings.prepareAudioAhead')}</span>
				<span class="preference-desc">{t('appSettings.prepareAudioAheadDesc')}</span>
			</span>
			<input
				class="preference-toggle"
				type="checkbox"
				role="switch"
				checked={prepareAudioAhead}
				onchange={updatePrepareAudioAhead}
			/>
		</label>
	</section>

	<section class="section">
		<h2>{t('settings.apiKeys.title')}</h2>
		<p class="section-desc">{t('settings.apiKeys.description')}</p>

		<h3 class="subsection-label">{t('settings.apiKeys.voiceSection')}</h3>
		{#each primaryServices as service}
			<div class="key-row">
				<div class="key-row-header">
					<div class="key-row-info">
						<span class="key-service-name">{serviceLabel(service)}</span>
						<span class="key-service-desc">{serviceDesc(service)}</span>
						<span class="key-service-cost">{serviceCost(service)}</span>
					</div>
					<div class="key-row-actions">
						{#if keyStatus[service]}
							<span class="badge badge--configured">{t('settings.apiKeys.configured')}</span>
						{:else}
							<span class="badge badge--not-configured">{t('settings.apiKeys.notConfigured')}</span>
						{/if}
						<button class="action-btn" type="button" onclick={() => toggleExpanded(service)}>
							{expanded[service] ? '×' : keyStatus[service] ? '✎' : '+'}
						</button>
					</div>
				</div>

				{#if messages[service]}
					<p class="key-message" class:key-message--ok={messages[service]!.ok} class:key-message--err={!messages[service]!.ok}>
						{messages[service]!.text}
					</p>
				{/if}

				{#if keyStatus[service] && !expanded[service]}
					<div class="key-remove-row">
						<button
							class="btn-danger"
							disabled={removing[service]}
							onclick={() => removeKey(service)}
						>
							{#if removing[service]}<Spinner size={13} />{/if}
							{removing[service] ? t('settings.apiKeys.removing') : t('settings.apiKeys.remove')}
						</button>
					</div>
				{/if}

				{#if expanded[service]}
					<div class="key-input-area">
						<input
							class="key-input"
							type="password"
							placeholder={t('settings.apiKeys.placeholder')}
							bind:value={keyInputs[service]}
							onkeydown={(e) => { if (e.key === 'Enter') saveKey(service); }}
						/>
						<div class="key-input-footer">
							<span class="key-link-hint">
								{t('settings.apiKeys.getKey')}
								<a href={serviceHrefs[service]} target="_blank" rel="noopener noreferrer">
									{serviceLinks[service]}
								</a>
							</span>
							<button
								class="btn-primary"
								disabled={saving[service] || !keyInputs[service].trim()}
								onclick={() => saveKey(service)}
							>
								{#if saving[service]}<Spinner size={13} />{/if}
							{saving[service] ? t('settings.apiKeys.validating') : t('settings.apiKeys.save')}
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/each}

		<h3 class="subsection-label subsection-label--optional">{t('settings.apiKeys.advancedSection')}</h3>
		<p class="section-desc">{t('settings.apiKeys.advancedDesc')}</p>
		{#each advancedServices as service}
			<div class="key-row">
				<div class="key-row-header">
					<div class="key-row-info">
						<span class="key-service-name">{serviceLabel(service)}</span>
						<span class="key-service-desc">{serviceDesc(service)}</span>
						<span class="key-service-cost">{serviceCost(service)}</span>
					</div>
					<div class="key-row-actions">
						{#if keyStatus[service]}
							<span class="badge badge--configured">{t('settings.apiKeys.configured')}</span>
						{:else}
							<span class="badge badge--not-configured">{t('settings.apiKeys.notConfigured')}</span>
						{/if}
						<button class="action-btn" type="button" onclick={() => toggleExpanded(service)}>
							{expanded[service] ? '×' : keyStatus[service] ? '✎' : '+'}
						</button>
					</div>
				</div>

				{#if messages[service]}
					<p class="key-message" class:key-message--ok={messages[service]!.ok} class:key-message--err={!messages[service]!.ok}>
						{messages[service]!.text}
					</p>
				{/if}

				{#if keyStatus[service] && !expanded[service]}
					<div class="key-remove-row">
						<button
							class="btn-danger"
							disabled={removing[service]}
							onclick={() => removeKey(service)}
						>
							{#if removing[service]}<Spinner size={13} />{/if}
							{removing[service] ? t('settings.apiKeys.removing') : t('settings.apiKeys.remove')}
						</button>
					</div>
				{/if}

				{#if expanded[service]}
					<div class="key-input-area">
						<input
							class="key-input"
							type="password"
							placeholder={t('settings.apiKeys.placeholder')}
							bind:value={keyInputs[service]}
							onkeydown={(e) => { if (e.key === 'Enter') saveKey(service); }}
						/>
						<div class="key-input-footer">
							<span class="key-link-hint">
								{t('settings.apiKeys.getKey')}
								<a href={serviceHrefs[service]} target="_blank" rel="noopener noreferrer">
									{serviceLinks[service]}
								</a>
							</span>
							<button
								class="btn-primary"
								disabled={saving[service] || !keyInputs[service].trim()}
								onclick={() => saveKey(service)}
							>
								{#if saving[service]}<Spinner size={13} />{/if}
							{saving[service] ? t('settings.apiKeys.validating') : t('settings.apiKeys.save')}
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</section>

	<section class="section">
		<h2>{t('settings.usage.title')}</h2>
		{#if loadingUsage}
			<div class="usage-loading"><Spinner size={22} /></div>
		{:else if !usageData || allZero(usageData)}
			<p class="muted">{t('settings.usage.noUsage')}</p>
		{:else}
			<div class="usage-table-wrap">
				<div class="usage-table">
					<div class="usage-head">
						<span></span>
						<span>{t('settings.usage.today')}</span>
						<span>{t('settings.usage.week')}</span>
						<span>{t('settings.usage.month')}</span>
					</div>
					{#each usageServices as s}
						<div class="usage-row">
							<span class="usage-service">{serviceLabel(s as Service)}</span>
							<span>{formatCost(usageData!.today[s as Service])}</span>
							<span>{formatCost(usageData!.week[s as Service])}</span>
							<span>{formatCost(usageData!.month[s as Service])}</span>
						</div>
					{/each}
					<div class="usage-row usage-row--total">
						<span>{t('settings.usage.total')}</span>
						<span>{formatCost(usageData!.today.total)}</span>
						<span>{formatCost(usageData!.week.total)}</span>
						<span>{formatCost(usageData!.month.total)}</span>
					</div>
				</div>
			</div>
			<p class="usage-note">{t('settings.usage.note')}</p>
		{/if}
	</section>
</div>
{/key}


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

	.section {
		margin-bottom: 2rem;
	}

	.section h2 {
		font-size: 1rem;
		color: #b0b0d0;
		margin-bottom: 0.75rem;
	}

	.section-desc {
		font-size: 0.85rem;
		color: #7a7a9a;
		margin: 0 0 1rem;
		line-height: 1.5;
	}

	.subsection-label {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #7a7a9a;
		margin: 1rem 0 0.5rem;
	}

	.subsection-label--optional {
		margin-top: 1.5rem;
	}

	.lang-options {
		display: flex;
		gap: 0.5rem;
	}

	.lang-btn {
		padding: 0.6rem 1.5rem;
		background: #22223a;
		border: 1px solid #3a3a5e;
		color: #a8a8b8;
		border-radius: 8px;
		cursor: pointer;
		font-size: 1rem;
		transition: all 0.15s;
		touch-action: manipulation;
	}

	.lang-btn:hover {
		border-color: #5a5a8e;
		color: #e0e0ff;
	}

	.lang-btn.active {
		background: #3a3a6e;
		border-color: #5a5a8e;
		color: #e0e0ff;
		font-weight: 600;
	}

	.voice-provider-group {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 10px;
		padding: 0.9rem 1rem;
		margin-bottom: 0.75rem;
	}

	.voice-language-group {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 10px;
		padding: 0.9rem 1rem;
		margin-bottom: 0.75rem;
	}

	.voice-provider-copy {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin-bottom: 0.75rem;
	}

	.provider-options {
		display: grid;
		gap: 0.5rem;
	}

	.provider-option {
		display: flex;
		align-items: flex-start;
		gap: 0.65rem;
		padding: 0.7rem;
		border: 1px solid #2e2e52;
		border-radius: 8px;
		cursor: pointer;
		background: #17172a;
	}

	.provider-option.active {
		border-color: #6666b8;
		background: #202045;
	}

	.provider-option input {
		margin-top: 0.15rem;
		accent-color: #8b8bea;
	}

	.provider-option span {
		display: flex;
		flex-direction: column;
		gap: 0.18rem;
	}

	.provider-option strong {
		font-size: 0.9rem;
		color: #dadaff;
	}

	.provider-option small {
		font-size: 0.78rem;
		line-height: 1.35;
		color: #8d8db0;
	}

	.segmented-control {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.35rem;
		padding: 0.25rem;
		border: 1px solid #2e2e52;
		border-radius: 8px;
		background: #151526;
	}

	.segment-option {
		position: relative;
		min-width: 0;
		padding: 0.55rem 0.3rem;
		border-radius: 6px;
		color: #a8a8c8;
		text-align: center;
		cursor: pointer;
		font-size: 0.85rem;
		font-weight: 600;
	}

	.segment-option.active {
		background: #303060;
		color: #f0f0ff;
	}

	.segment-option input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.segment-option span {
		display: block;
		overflow-wrap: anywhere;
	}

	.preference-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 10px;
		padding: 0.85rem 1rem;
		cursor: pointer;
	}

	.preference-copy {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}

	.preference-title {
		font-size: 0.95rem;
		font-weight: 600;
		color: #d0d0f0;
	}

	.preference-desc {
		font-size: 0.82rem;
		line-height: 1.45;
		color: #7a7a9a;
	}

	.preference-toggle {
		width: 2.7rem;
		height: 1.5rem;
		flex: 0 0 auto;
		accent-color: #6b6bc8;
		cursor: pointer;
	}

	/* Key rows */
	.key-row {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 10px;
		padding: 0.85rem 1rem;
		margin-bottom: 0.6rem;
	}

	.key-row-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.key-row-info {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		flex: 1;
		min-width: 0;
	}

	.key-service-name {
		font-size: 0.95rem;
		font-weight: 600;
		color: #d0d0f0;
	}

	.key-service-desc {
		font-size: 0.82rem;
		color: #7a7a9a;
	}

	.key-service-cost {
		font-size: 0.78rem;
		color: #5a5a7a;
	}

	.key-row-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.badge {
		font-size: 0.72rem;
		font-weight: 600;
		padding: 0.2rem 0.55rem;
		border-radius: 99px;
	}

	.badge--configured {
		background: #1a3a2a;
		color: #4aaa74;
		border: 1px solid #2a5a3a;
	}

	.badge--not-configured {
		background: #22223a;
		color: #6a6a8a;
		border: 1px solid #3a3a5e;
	}

	.action-btn {
		background: #22223a;
		border: 1px solid #3a3a5e;
		color: #a8a8b8;
		border-radius: 6px;
		cursor: pointer;
		font-size: 1.1rem;
		width: 2.5rem;
		height: 2.5rem;
		display: flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s;
		padding: 0;
		-webkit-tap-highlight-color: rgba(90, 90, 142, 0.3);
		touch-action: manipulation;
	}

	.action-btn:hover {
		border-color: #5a5a8e;
		color: #e0e0ff;
	}

	.key-message {
		font-size: 0.82rem;
		margin: 0.5rem 0 0;
		padding: 0.4rem 0.6rem;
		border-radius: 6px;
	}

	.key-message--ok {
		background: #1a3a2a;
		color: #4aaa74;
	}

	.key-message--err {
		background: #3a1a1a;
		color: #cc6666;
	}

	.key-remove-row {
		margin-top: 0.65rem;
	}

	.key-input-area {
		margin-top: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.key-input {
		width: 100%;
		padding: 0.55rem 0.75rem;
		background: #12121f;
		border: 1px solid #3a3a5e;
		border-radius: 7px;
		color: #e0e0ff;
		font-size: 0.9rem;
		font-family: monospace;
		box-sizing: border-box;
		transition: border-color 0.15s;
	}

	.key-input:focus {
		outline: none;
		border-color: #5a5a9e;
	}

	.key-input-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		flex-wrap: wrap;
	}

	.key-link-hint {
		font-size: 0.78rem;
		color: #6a6a8a;
	}

	.key-link-hint a {
		color: #7a7aaa;
		text-decoration: underline;
	}

	.key-link-hint a:hover {
		color: #a0a0e0;
	}

	.usage-loading {
		display: flex;
		justify-content: center;
		padding: 1.5rem 0;
		color: #8080c0;
	}

	.btn-primary {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.5rem 1.1rem;
		background: #3a3a6e;
		border: 1px solid #5a5a8e;
		color: #e0e0ff;
		border-radius: 7px;
		cursor: pointer;
		font-size: 0.88rem;
		font-weight: 600;
		transition: all 0.15s;
		white-space: nowrap;
		touch-action: manipulation;
	}

	.btn-primary:hover:not(:disabled) {
		background: #4a4a8e;
		border-color: #7a7aae;
	}

	.btn-primary:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.btn-danger {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.4rem 0.9rem;
		background: #2a1a1a;
		border: 1px solid #5a2a2a;
		color: #cc6666;
		border-radius: 7px;
		cursor: pointer;
		font-size: 0.82rem;
		font-weight: 600;
		transition: all 0.15s;
		touch-action: manipulation;
	}

	.btn-danger:hover:not(:disabled) {
		background: #3a1a1a;
		border-color: #7a3a3a;
		color: #e07070;
	}

	.btn-danger:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	/* Usage table */
	.usage-table-wrap {
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		margin-bottom: 0.75rem;
		border-radius: 10px;
	}

	.usage-table {
		border: 1px solid #2a2a4a;
		border-radius: 10px;
		overflow: hidden;
		min-width: 340px;
	}

	.usage-head,
	.usage-row {
		display: grid;
		grid-template-columns: 1fr repeat(3, 80px);
		gap: 0;
	}

	.usage-head {
		background: #12121f;
		border-bottom: 1px solid #2a2a4a;
	}

	.usage-head span {
		padding: 0.5rem 0.65rem;
		font-size: 0.72rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #6a6a8a;
		text-align: right;
	}

	.usage-head span:first-child {
		text-align: left;
	}

	.usage-row {
		border-bottom: 1px solid #1e1e38;
	}

	.usage-row:last-child {
		border-bottom: none;
	}

	.usage-row span {
		padding: 0.55rem 0.65rem;
		font-size: 0.85rem;
		color: #a0a0c0;
		text-align: right;
	}

	.usage-service {
		text-align: left !important;
		color: #c0c0e0 !important;
		font-size: 0.82rem !important;
	}

	.usage-row--total {
		background: #12121f;
		border-top: 1px solid #2a2a4a !important;
	}

	.usage-row--total span {
		font-weight: 600;
		color: #d0d0f0;
	}

	.usage-note {
		font-size: 0.78rem;
		color: #5a5a7a;
		margin: 0;
		line-height: 1.5;
	}

	.muted {
		color: #5a5a7a;
		font-size: 0.88rem;
	}
</style>

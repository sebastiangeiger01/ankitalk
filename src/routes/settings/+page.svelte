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
		elevenlabs_speaker_boost: true,
		elevenlabs_agent_id: null
	});
	let savingVoiceSettings = $state(false);
	let voiceSettingsMessage = $state<{ text: string; ok: boolean } | null>(null);

	let usageData = $state<UsageData | null>(null);
	let loadingUsage = $state(false);

	/**
	 * Agent conversation usage logged through AnkiTalk this month. ElevenLabs doesn't
	 * expose CAI minutes via API, so this is a local-only tally — see the note rendered
	 * below the figure.
	 */
	let agentUsage = $state<{ month_seconds: number; month_cost_usd: number } | null>(null);
	type AgentReadinessIssue = 'agent_not_configured' | 'agent_not_found' | 'invalid_api_key' | 'insufficient_permissions' | 'mcp_server_not_found' | 'mcp_auth_failed' | 'mcp_not_assigned' | 'mcp_tools_missing' | 'elevenlabs_unavailable';
	interface AgentReadiness {
		ready: boolean;
		issues: AgentReadinessIssue[];
		agent: { configured: boolean; reachable: boolean };
		mcp: { server_found: boolean; authenticated: boolean; assigned_to_agent: boolean; tools_found: string[]; missing_tools: string[] };
	}
	let agentReadiness = $state<AgentReadiness | null>(null);
	let checkingAgentReadiness = $state(false);

	async function checkAgentSetup() {
		if (checkingAgentReadiness) return;
		checkingAgentReadiness = true;
		try {
			const res = await fetch('/api/settings/agent-readiness', { cache: 'no-store' });
			agentReadiness = res.ok ? await res.json() as AgentReadiness : null;
		} catch {
			agentReadiness = null;
		} finally {
			checkingAgentReadiness = false;
		}
	}

	function readinessIssueText(issue: AgentReadinessIssue): string {
		return $t(`settings.agent.readiness.issues.${issue}`);
	}

	// MCP token management. Plaintext tokens are only available at creation time; after
	// that we only ever show the prefix and metadata. `mcpTokenJustCreated` holds the
	// one-time-visible plaintext briefly while the user copies it.
	interface McpTokenRow {
		id: string;
		prefix: string;
		label: string | null;
		created_at: string;
		last_used_at: string | null;
		scopes: string;
		expires_at: string | null;
	}
	let mcpTokens = $state<McpTokenRow[]>([]);
	let mcpTokenJustCreated = $state<string | null>(null);
	let creatingMcpToken = $state(false);
	let mcpTokenProfile = $state<'study' | 'author'>('study');
	const mcpEndpointUrl = $derived(
		typeof window === 'undefined' ? '/api/mcp' : `${window.location.origin}/api/mcp`
	);

	async function loadMcpTokens() {
		try {
			const res = await fetch('/api/mcp/tokens');
			if (res.ok) {
				const data = (await res.json()) as { tokens: McpTokenRow[] };
				mcpTokens = data.tokens;
			}
		} catch {
			// silent — settings page already handles its own loading state elsewhere
		}
	}

	async function createMcpToken() {
		if (creatingMcpToken) return;
		creatingMcpToken = true;
		try {
			const res = await fetch('/api/mcp/tokens', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ label: '', profile: mcpTokenProfile, expires_in_days: 365 })
			});
			if (res.ok) {
				const data = (await res.json()) as { plaintext: string };
				mcpTokenJustCreated = data.plaintext;
				await loadMcpTokens();
			}
		} finally {
			creatingMcpToken = false;
		}
	}

	async function revokeMcpToken(id: string) {
		// In-place removal first so the UI feels instant; reload on success to pick up any
		// concurrent changes from a second tab.
		mcpTokens = mcpTokens.filter((t) => t.id !== id);
		try {
			await fetch(`/api/mcp/tokens/${id}`, { method: 'DELETE' });
		} catch {
			/* silent — UI already reflects the intent */
		}
		await loadMcpTokens();
	}

	async function copyToClipboard(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			/* clipboard blocked in some browsers — user can still select and copy manually */
		}
	}

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
		if (keyStatus.elevenlabs && voiceSettings.elevenlabs_agent_id) void checkAgentSetup();

		loadingUsage = true;
		try {
			const [usageRes, agentRes] = await Promise.all([
				fetch('/api/settings/usage'),
				fetch('/api/agent/usage'),
				loadMcpTokens()
			]);
			if (usageRes.ok) usageData = await usageRes.json() as UsageData;
			if (agentRes.ok) agentUsage = await agentRes.json();
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
				voiceSettingsMessage = { text: $t('settings.voice.saved'), ok: true };
				setTimeout(() => { voiceSettingsMessage = null; }, 2000);
				if (data.settings.elevenlabs_agent_id !== previousSettings.elevenlabs_agent_id && keyStatus.elevenlabs) void checkAgentSetup();
			} else {
				throw new Error('Failed to save voice settings');
			}
		} catch {
			voiceSettings = previousSettings;
			voiceSettingsMessage = { text: $t('settings.voice.saveFailed'), ok: false };
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
				messages[service] = { text: $t('settings.apiKeys.saved'), ok: true };
				if (service === 'elevenlabs' && voiceSettings.elevenlabs_agent_id) void checkAgentSetup();
			} else {
				const errKey = res.status === 429
					? 'settings.apiKeys.rateLimited'
					: res.status === 403 && service === 'deepgram'
						? 'settings.apiKeys.deepgramPermissions'
						: res.status === 403 && service === 'elevenlabs'
							? 'settings.apiKeys.elevenlabsPermissions'
							: 'settings.apiKeys.invalid';
				messages[service] = { text: $t(errKey), ok: false };
			}
		} catch {
			messages[service] = { text: $t('settings.apiKeys.invalid'), ok: false };
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
				messages[service] = { text: $t('settings.apiKeys.removed'), ok: true };
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
	const advancedServices: Service[] = ['openai', 'deepgram'];
	const usageServices: Service[] = ['elevenlabs', 'openai', 'deepgram'];
	const voiceCommandLanguages: VoiceCommandLanguage[] = ['auto', 'en', 'de'];

	function serviceLabel(s: Service): string {
		return $t(`settings.apiKeys.${s}`);
	}
	function serviceDesc(s: Service): string {
		return $t(`settings.apiKeys.${s}Desc`);
	}
	function serviceCost(s: Service): string {
		return $t(`settings.apiKeys.${s}Cost`);
	}
</script>

{#key current}
<div class="settings-page">
	<a href="/" class="back-link">&larr; {$t('appSettings.dashboard')}</a>

	<h1>{$t('appSettings.title')}</h1>

	<section class="section">
		<h2>{$t('appSettings.language')}</h2>
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
		<h2>{$t('appSettings.audio')}</h2>
		<div class="voice-provider-group" aria-label={$t('settings.voice.title')}>
			<div class="voice-provider-copy">
				<span class="preference-title">{$t('settings.voice.title')}</span>
				<span class="preference-desc">{$t('settings.voice.desc')}</span>
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
						<strong>{$t('settings.voice.elevenlabs')}</strong>
						<small>{$t('settings.voice.elevenlabsDesc')}</small>
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
						<strong>{$t('settings.voice.legacy')}</strong>
						<small>{$t('settings.voice.legacyDesc')}</small>
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
		<div class="voice-language-group" aria-label={$t('settings.voice.commandLanguage')}>
			<div class="voice-provider-copy">
				<span class="preference-title">{$t('settings.voice.commandLanguage')}</span>
				<span class="preference-desc">
					{voiceSettings.voice_command_language === 'auto'
						? $t('settings.voice.commandLanguageAutoDesc')
						: $t('settings.voice.commandLanguageFixedDesc')}
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
						<span>{$t(`settings.voice.commandLanguage.${language}`)}</span>
					</label>
				{/each}
			</div>
		</div>
		<label class="preference-row">
			<span class="preference-copy">
				<span class="preference-title">{$t('appSettings.prepareAudioAhead')}</span>
				<span class="preference-desc">{$t('appSettings.prepareAudioAheadDesc')}</span>
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
		<h2>{$t('settings.apiKeys.title')}</h2>
		<p class="section-desc">{$t('settings.apiKeys.description')}</p>

		<h3 class="subsection-label">{$t('settings.apiKeys.voiceSection')}</h3>
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
							<span class="badge badge--configured">{$t('settings.apiKeys.configured')}</span>
						{:else}
							<span class="badge badge--not-configured">{$t('settings.apiKeys.notConfigured')}</span>
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
							{removing[service] ? $t('settings.apiKeys.removing') : $t('settings.apiKeys.remove')}
						</button>
					</div>
				{/if}

				{#if expanded[service]}
					<div class="key-input-area">
						<input
							class="key-input"
							type="password"
							placeholder={$t('settings.apiKeys.placeholder')}
							bind:value={keyInputs[service]}
							onkeydown={(e) => { if (e.key === 'Enter') saveKey(service); }}
						/>
						{#if service === 'elevenlabs'}
							<div class="perm-hint">
								<span class="perm-hint-title">{$t('settings.apiKeys.elevenlabsPerms.title')}</span>
								<span class="perm-hint-intro">{$t('settings.apiKeys.elevenlabsPerms.intro')}</span>
								<ul class="perm-list">
									<li>{$t('settings.apiKeys.elevenlabsPerms.tts')}</li>
									<li>{$t('settings.apiKeys.elevenlabsPerms.stt')}</li>
									<li>{$t('settings.apiKeys.elevenlabsPerms.agents')}</li>
									<li>{$t('settings.apiKeys.elevenlabsPerms.voices')}</li>
									<li>{$t('settings.apiKeys.elevenlabsPerms.user')}</li>
								</ul>
							</div>
						{/if}
						<div class="key-input-footer">
							<span class="key-link-hint">
								{$t('settings.apiKeys.getKey')}
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
							{saving[service] ? $t('settings.apiKeys.validating') : $t('settings.apiKeys.save')}
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/each}

		<h3 class="subsection-label subsection-label--optional">{$t('settings.apiKeys.advancedSection')}</h3>
		<p class="section-desc">{$t('settings.apiKeys.advancedDesc')}</p>
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
							<span class="badge badge--configured">{$t('settings.apiKeys.configured')}</span>
						{:else}
							<span class="badge badge--not-configured">{$t('settings.apiKeys.notConfigured')}</span>
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
							{removing[service] ? $t('settings.apiKeys.removing') : $t('settings.apiKeys.remove')}
						</button>
					</div>
				{/if}

				{#if expanded[service]}
					<div class="key-input-area">
						<input
							class="key-input"
							type="password"
							placeholder={$t('settings.apiKeys.placeholder')}
							bind:value={keyInputs[service]}
							onkeydown={(e) => { if (e.key === 'Enter') saveKey(service); }}
						/>
						{#if service === 'elevenlabs'}
							<div class="perm-hint">
								<span class="perm-hint-title">{$t('settings.apiKeys.elevenlabsPerms.title')}</span>
								<span class="perm-hint-intro">{$t('settings.apiKeys.elevenlabsPerms.intro')}</span>
								<ul class="perm-list">
									<li>{$t('settings.apiKeys.elevenlabsPerms.tts')}</li>
									<li>{$t('settings.apiKeys.elevenlabsPerms.stt')}</li>
									<li>{$t('settings.apiKeys.elevenlabsPerms.voices')}</li>
									<li>{$t('settings.apiKeys.elevenlabsPerms.user')}</li>
								</ul>
							</div>
						{/if}
						<div class="key-input-footer">
							<span class="key-link-hint">
								{$t('settings.apiKeys.getKey')}
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
							{saving[service] ? $t('settings.apiKeys.validating') : $t('settings.apiKeys.save')}
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/each}
	</section>

	<section class="section">
		<h2>
			{$t('settings.agent.title')}
			{#if agentReadiness?.ready}
				<span class="badge badge--configured">{$t('settings.apiKeys.configured')}</span>
			{:else}
				<span class="badge badge--not-configured">{$t('settings.apiKeys.notConfigured')}</span>
			{/if}
		</h2>
		<p class="section-desc">{$t('settings.agent.desc')}</p>

		<details class="agent-setup">
			<summary>{$t('settings.agent.setupTitle')}</summary>
			<ol class="agent-setup-steps">
				<li>{$t('settings.agent.setupStep1')} <a href="https://elevenlabs.io/app/agents" target="_blank" rel="noopener noreferrer">{$t('settings.agent.dashboardLink')} →</a></li>
				<li>{$t('settings.agent.setupStep2')}</li>
				<li>{$t('settings.agent.setupStep3')}</li>
				<li>{$t('settings.agent.setupStep4')}</li>
			</ol>
			<p class="agent-help agent-help--warn">{$t('settings.agent.setupScopeWarning')}</p>
		</details>

		<label class="agent-field">
			<span class="agent-label">{$t('settings.agent.agentIdLabel')}</span>
			<input
				type="text"
				class="agent-input"
				placeholder={$t('settings.agent.agentIdPlaceholder')}
				value={voiceSettings.elevenlabs_agent_id ?? ''}
				onblur={(e) => {
					const next = (e.currentTarget as HTMLInputElement).value.trim();
					const previous = { ...voiceSettings };
					void saveVoiceSettings({ ...voiceSettings, elevenlabs_agent_id: next || null }, previous);
				}}
			/>
		</label>
		<p class="agent-help">{$t('settings.agent.agentIdHelp')}</p>

		<div class="agent-readiness" class:agent-readiness--ready={agentReadiness?.ready}>
			<div class="agent-readiness-head">
				<div>
					<strong>{agentReadiness?.ready ? $t('settings.agent.readiness.ready') : $t('settings.agent.readiness.title')}</strong>
					<p>{agentReadiness?.ready ? $t('settings.agent.readiness.readyDesc') : $t('settings.agent.readiness.desc')}</p>
				</div>
				<button class="action-btn" type="button" onclick={checkAgentSetup} disabled={checkingAgentReadiness}>
					{checkingAgentReadiness ? $t('settings.agent.readiness.checking') : $t('settings.agent.readiness.check')}
				</button>
			</div>
			{#if agentReadiness}
				<ul class="agent-readiness-list">
					<li class:ok={agentReadiness.agent.reachable}>{agentReadiness.agent.reachable ? '✓' : '○'} {$t('settings.agent.readiness.agent')}</li>
					<li class:ok={agentReadiness.mcp.server_found}>{agentReadiness.mcp.server_found ? '✓' : '○'} {$t('settings.agent.readiness.server')}</li>
					<li class:ok={agentReadiness.mcp.authenticated}>{agentReadiness.mcp.authenticated ? '✓' : '○'} {$t('settings.agent.readiness.auth')}</li>
					<li class:ok={agentReadiness.mcp.assigned_to_agent}>{agentReadiness.mcp.assigned_to_agent ? '✓' : '○'} {$t('settings.agent.readiness.assignment')}</li>
					<li class:ok={agentReadiness.mcp.authenticated && agentReadiness.mcp.missing_tools.length === 0}>{agentReadiness.mcp.authenticated && agentReadiness.mcp.missing_tools.length === 0 ? '✓' : '○'} {$t('settings.agent.readiness.tools', { count: agentReadiness.mcp.tools_found.length })}</li>
				</ul>
				{#if agentReadiness.issues.length}
					<div class="agent-readiness-issues">
						{#each agentReadiness.issues as issue}<p>{readinessIssueText(issue)}</p>{/each}
					</div>
				{/if}
			{/if}
		</div>

		<div class="agent-usage">
			<div class="agent-usage-head">
				<strong>{$t('settings.agent.usageTitle')}</strong>
			</div>
			<div class="agent-usage-body">
				<span>{$t('settings.agent.usageMinutes', { minutes: Math.round((agentUsage?.month_seconds ?? 0) / 60) })}</span>
				<span class="agent-usage-cost">{$t('settings.agent.usageCost', { cost: (agentUsage?.month_cost_usd ?? 0).toFixed(2) })}</span>
			</div>
			<p class="agent-usage-note">{$t('settings.agent.usageNote')}</p>
			<p class="agent-help">
				<a href="https://elevenlabs.io/app/usage" target="_blank" rel="noopener noreferrer">
					{$t('settings.agent.usageDashboardLink')} →
				</a>
			</p>
		</div>
	</section>

	<section class="section">
		<h2>{$t('settings.mcp.title')}</h2>
		<p class="section-desc">{$t('settings.mcp.desc')}</p>

		<div class="mcp-endpoint">
			<span class="agent-label">{$t('settings.mcp.endpointLabel')}</span>
			<input type="text" class="agent-input mcp-endpoint-input" value={mcpEndpointUrl} readonly />
		</div>
		<p class="agent-help">{$t('settings.mcp.endpointHelp')}</p>

		<details class="agent-setup">
			<summary>{$t('settings.mcp.howToTitle')}</summary>
			<ol class="agent-setup-steps">
				<li>{$t('settings.mcp.howTo1')}</li>
				<li>{$t('settings.mcp.howTo2')}</li>
				<li>{$t('settings.mcp.howTo3')}</li>
				<li>{$t('settings.mcp.howTo4')}</li>
			</ol>
		</details>

		<div class="mcp-tokens-head">
			<strong>{$t('settings.mcp.tokensTitle')}</strong>
			<div class="mcp-token-create-controls">
				<select class="agent-input mcp-profile-select" bind:value={mcpTokenProfile} aria-label={$t('settings.mcp.profileLabel')}>
					<option value="study">{$t('settings.mcp.profileStudy')}</option>
					<option value="author">{$t('settings.mcp.profileAuthor')}</option>
				</select>
				<button class="action-btn" type="button" onclick={createMcpToken} disabled={creatingMcpToken}>
					{creatingMcpToken ? $t('common.saving') : $t('settings.mcp.createToken')}
				</button>
			</div>
		</div>

		{#if mcpTokenJustCreated}
			<div class="mcp-fresh">
				<p class="mcp-fresh-warn">{$t('settings.mcp.copyOnce')}</p>
				<div class="mcp-fresh-row">
					<code class="mcp-fresh-token">{mcpTokenJustCreated}</code>
					<button class="action-btn" type="button" onclick={() => copyToClipboard(mcpTokenJustCreated ?? '')}>{$t('settings.mcp.copy')}</button>
				</div>
				<button class="action-btn" type="button" onclick={() => (mcpTokenJustCreated = null)}>{$t('common.dismiss')}</button>
			</div>
		{/if}

		{#if mcpTokens.length === 0}
			<p class="muted">{$t('settings.mcp.noTokens')}</p>
		{:else}
			<ul class="mcp-tokens">
				<!-- `tok` rather than `t` so the local variable doesn't shadow the i18n store. -->
				{#each mcpTokens as tok (tok.id)}
					<li class="mcp-token">
						<div class="mcp-token-meta">
							<code class="mcp-token-prefix">{tok.prefix}…</code>
							{#if tok.label}<span class="mcp-token-label">{tok.label}</span>{/if}
							<span class="mcp-token-when">{tok.scopes.includes('cards:write') ? $t('settings.mcp.profileAuthor') : $t('settings.mcp.profileStudy')}</span>
							<span class="mcp-token-when">{$t('settings.mcp.createdAt', { date: tok.created_at })}</span>
							{#if tok.expires_at}<span class="mcp-token-when">{$t('settings.mcp.expiresAt', { date: tok.expires_at })}</span>{/if}
							{#if tok.last_used_at}
								<span class="mcp-token-when">{$t('settings.mcp.lastUsedAt', { date: tok.last_used_at })}</span>
							{:else}
								<span class="mcp-token-when muted">{$t('settings.mcp.neverUsed')}</span>
							{/if}
						</div>
						<button class="action-btn" type="button" onclick={() => revokeMcpToken(tok.id)}>{$t('settings.mcp.revoke')}</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="section">
		<h2>{$t('settings.usage.title')}</h2>
		{#if loadingUsage}
			<div class="usage-loading"><Spinner size={22} /></div>
		{:else if !usageData || allZero(usageData)}
			<p class="muted">{$t('settings.usage.noUsage')}</p>
		{:else}
			<div class="usage-table-wrap">
				<div class="usage-table">
					<div class="usage-head">
						<span></span>
						<span>{$t('settings.usage.today')}</span>
						<span>{$t('settings.usage.week')}</span>
						<span>{$t('settings.usage.month')}</span>
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
						<span>{$t('settings.usage.total')}</span>
						<span>{formatCost(usageData!.today.total)}</span>
						<span>{formatCost(usageData!.week.total)}</span>
						<span>{formatCost(usageData!.month.total)}</span>
					</div>
				</div>
			</div>
			<p class="usage-note">{$t('settings.usage.note')}</p>
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
	}

	.section {
		margin-bottom: 2rem;
	}

	.section h2 {
		font-size: 1rem;
		color: var(--text-muted);
		margin-bottom: 0.75rem;
	}

	.section-desc {
		font-size: 0.85rem;
		color: var(--text-subtle);
		margin: 0 0 1rem;
		line-height: 1.5;
	}

	.subsection-label {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-subtle);
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
		background: var(--surface);
		border: 1px solid var(--border);
		color: var(--text-muted);
		border-radius: 8px;
		cursor: pointer;
		font-size: 1rem;
		transition: all 0.15s;
		touch-action: manipulation;
	}

	.lang-btn:hover {
		border-color: var(--border-strong);
		color: var(--text);
	}

	.lang-btn.active {
		background: var(--primary);
		border-color: var(--border-strong);
		color: var(--text);
		font-weight: 600;
	}

	.voice-provider-group {
		background: var(--bg);
		border: 1px solid var(--border-muted);
		border-radius: 10px;
		padding: 0.9rem 1rem;
		margin-bottom: 0.75rem;
	}

	.voice-language-group {
		background: var(--bg);
		border: 1px solid var(--border-muted);
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
		border: 1px solid var(--surface-elevated);
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
		border: 1px solid var(--surface-elevated);
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
		background: var(--bg);
		border: 1px solid var(--border-muted);
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
		color: var(--text-subtle);
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
		background: var(--bg);
		border: 1px solid var(--border-muted);
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
		color: var(--text-subtle);
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
		background: var(--surface);
		color: #6a6a8a;
		border: 1px solid var(--border);
	}

	.action-btn {
		background: var(--surface);
		border: 1px solid var(--border);
		color: var(--text-muted);
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
		border-color: var(--border-strong);
		color: var(--text);
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
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 7px;
		color: var(--text);
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

	.perm-hint {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		padding: 0.6rem 0.75rem;
		background: var(--surface-2);
		border: 1px solid var(--surface-elevated);
		border-radius: 7px;
	}

	.perm-hint-title {
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--text-muted);
	}

	.perm-hint-intro {
		font-size: 0.76rem;
		color: var(--text-subtle);
		line-height: 1.4;
	}

	.perm-list {
		margin: 0;
		padding-left: 1.1rem;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.perm-list li {
		font-size: 0.76rem;
		color: #9a9ac0;
		line-height: 1.35;
	}

	.key-link-hint {
		font-size: 0.78rem;
		color: #6a6a8a;
	}

	.key-link-hint a {
		color: #7a7aaa;
		text-decoration: underline;
		/* Long provider URLs (console.anthropic.com/..., elevenlabs.io/...) would otherwise
		   force the whole settings page to scroll horizontally on a 320–375px viewport. */
		overflow-wrap: anywhere;
		word-break: break-word;
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
		background: var(--primary);
		border: 1px solid var(--border-strong);
		color: var(--text);
		border-radius: 7px;
		cursor: pointer;
		font-size: 0.88rem;
		font-weight: 600;
		transition: all 0.15s;
		white-space: nowrap;
		touch-action: manipulation;
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--primary);
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
		border: 1px solid var(--border-muted);
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
		background: var(--surface-2);
		border-bottom: 1px solid var(--border-muted);
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
		color: var(--text-muted);
		text-align: right;
	}

	.usage-service {
		text-align: left !important;
		color: #c0c0e0 !important;
		font-size: 0.82rem !important;
	}

	.usage-row--total {
		background: var(--surface-2);
		border-top: 1px solid var(--border-muted) !important;
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

	/* Conversational tutor (Lernen agent) settings block. */
	.agent-field { display: block; margin: 0.8rem 0 0.4rem; }
	.agent-label { display: block; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.3rem; font-weight: 600; }
	.agent-input {
		width: 100%; box-sizing: border-box;
		padding: 0.55rem 0.7rem; border-radius: 7px;
		background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
		font-size: 0.95rem; font-family: monospace;
	}
	.agent-input:focus { outline: none; border-color: var(--border-strong); }
	.agent-help { font-size: 0.78rem; color: var(--text-muted); margin: 0.3rem 0; line-height: 1.4; }
	.agent-help a { color: var(--primary); text-decoration: underline; }
	.agent-usage {
		margin-top: 1rem; padding: 0.7rem 0.85rem;
		background: var(--surface); border: 1px solid var(--border-muted);
		border-radius: 10px;
	}
	.agent-usage-head { margin-bottom: 0.35rem; font-size: 0.9rem; color: var(--text); }
	.agent-usage-body {
		display: flex; align-items: baseline; gap: 0.6rem;
		font-size: 1rem; color: var(--text);
		font-variant-numeric: tabular-nums;
	}
	.agent-usage-cost { color: var(--text-muted); font-size: 0.85rem; }
	.agent-usage-note { font-size: 0.78rem; color: var(--text-subtle); margin: 0.45rem 0 0.25rem; line-height: 1.4; }

	/* Numbered setup checklist used by both the agent and MCP panels. */
	.agent-setup {
		margin: 0.6rem 0 0.8rem;
		background: var(--surface);
		border: 1px solid var(--border-muted);
		border-radius: 8px;
		padding: 0.55rem 0.8rem;
	}
	.agent-setup summary {
		cursor: pointer; font-size: 0.85rem; color: var(--text); font-weight: 600;
		list-style: none;
	}
	.agent-setup summary::-webkit-details-marker { display: none; }
	.agent-setup summary::before { content: '▸ '; color: var(--text-muted); }
	.agent-setup[open] summary::before { content: '▾ '; }
	.agent-setup-steps {
		margin: 0.6rem 0 0.3rem 1.1rem; padding: 0;
		font-size: 0.84rem; color: var(--text-muted); line-height: 1.55;
	}
	.agent-setup-steps li { margin-bottom: 0.25rem; }
	.agent-setup-steps a { color: var(--primary); text-decoration: underline; }
	.agent-help--warn { color: var(--warning); }

	/* MCP-specific styling: endpoint URL field, tokens list. */
	.mcp-endpoint { display: block; margin: 0.4rem 0 0.3rem; }
	.mcp-endpoint-input { font-size: 0.8rem; }
	.mcp-tokens-head {
		display: flex; align-items: center; justify-content: space-between;
		margin: 0.9rem 0 0.5rem;
	}
	.mcp-token-create-controls { display: flex; align-items: center; gap: 0.45rem; }
	.mcp-profile-select { width: auto; min-width: 150px; font-size: 0.78rem; padding: 0.42rem 0.55rem; }
	.mcp-fresh {
		background: var(--surface-2); border: 1px solid var(--warning);
		border-radius: 8px; padding: 0.7rem; margin-bottom: 0.7rem;
		display: flex; flex-direction: column; gap: 0.5rem;
	}
	.mcp-fresh-warn { font-size: 0.82rem; color: var(--warning); margin: 0; font-weight: 600; }
	.mcp-fresh-row { display: flex; align-items: center; gap: 0.5rem; }
	.mcp-fresh-token {
		flex: 1; min-width: 0;
		font-family: monospace; font-size: 0.78rem;
		padding: 0.4rem 0.55rem;
		background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.mcp-tokens { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.45rem; }
	.mcp-token {
		display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;
		padding: 0.55rem 0.7rem;
		background: var(--surface); border: 1px solid var(--border-muted); border-radius: 8px;
		font-size: 0.85rem;
	}
	.mcp-token-meta { display: flex; flex-wrap: wrap; gap: 0.4rem 0.7rem; align-items: baseline; min-width: 0; }
	.mcp-token-prefix { font-family: monospace; color: var(--text); }
	.mcp-token-label { color: var(--text-muted); }
	.mcp-token-when { font-size: 0.75rem; color: var(--text-subtle); }
	.agent-readiness { margin: 1rem 0; padding: 0.9rem; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg-subtle); }
	.agent-readiness--ready { border-color: color-mix(in srgb, #34c759 55%, var(--border)); }
	.agent-readiness-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
	.agent-readiness-head p { margin: 0.2rem 0 0; color: var(--text-muted); font-size: 0.82rem; }
	.agent-readiness-list { list-style: none; padding: 0; margin: 0.75rem 0 0; display: grid; gap: 0.35rem; font-size: 0.82rem; color: var(--text-muted); }
	.agent-readiness-list li.ok { color: #25a244; }
	.agent-readiness-issues { margin-top: 0.75rem; padding: 0.65rem; border-radius: var(--r-sm); background: color-mix(in srgb, var(--warning) 10%, transparent); }
	.agent-readiness-issues p { margin: 0.2rem 0; font-size: 0.8rem; color: var(--text); }
</style>

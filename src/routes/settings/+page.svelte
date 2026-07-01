<script lang="ts">
	import { onMount } from 'svelte';
	import { replaceState } from '$app/navigation';
	import { getPrepareAudioAhead, setPrepareAudioAhead } from '$lib/client/preferences';
	import { locale, t, type Locale } from '$lib/i18n';
	import Spinner from '$lib/components/Spinner.svelte';
	import SavedFlag from '$lib/components/SavedFlag.svelte';
	import ElevenLabsSettings from '$lib/components/ElevenLabsSettings.svelte';
	import { SavedFlags } from '$lib/client/saved-flags.svelte';
	import type { UserVoiceSettings, VoiceCommandLanguage, VoiceProvider } from '$lib/voice';

	function setLocale(l: Locale) {
		locale.set(l);
	}

	let loggingOut = $state(false);
	async function logout() {
		loggingOut = true;
		try {
			const { register } = await import('@teamhanko/hanko-elements');
			const { env } = await import('$env/dynamic/public');
			const { hanko } = await register(env.PUBLIC_HANKO_API_URL!);
			await hanko.user.logout();
			window.location.href = '/login';
		} catch {
			loggingOut = false;
		}
	}

	let current = $state<Locale>('en');
	let prepareAudioAhead = $state(true);
	$effect(() => {
		return locale.subscribe((v) => { current = v; });
	});

	// Transient "Saved ✓" feedback for all instant-save controls, keyed by control group.
	const savedFlags = new SavedFlags();

	// --- In-page section navigation ---
	const navSections = [
		{ id: 'section-language', labelKey: 'settings.nav.language' },
		{ id: 'section-keys', labelKey: 'settings.nav.keys' },
		{ id: 'section-audio', labelKey: 'settings.nav.audio' },
		{ id: 'section-tutor', labelKey: 'settings.nav.tutor' },
		{ id: 'mcp-integration', labelKey: 'settings.nav.mcp' },
		{ id: 'section-usage', labelKey: 'settings.nav.usage' },
		{ id: 'section-account', labelKey: 'settings.nav.account' }
	] as const;
	let activeSection = $state<string>('section-language');
	// Height of the app's sticky top nav; the section nav sits directly beneath it. Measured
	// (not hardcoded) because iOS safe-area insets change the nav height per device.
	let navOffset = $state(61);

	$effect(() => {
		const appNav = document.querySelector<HTMLElement>('nav:not(.section-nav)');
		if (!appNav) return;
		const update = () => { navOffset = appNav.offsetHeight; };
		update();
		const observer = new ResizeObserver(update);
		observer.observe(appNav);
		return () => observer.disconnect();
	});

	$effect(() => {
		// The `{#key current}` block recreates every section on locale change, so re-observe.
		void current;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) activeSection = entry.target.id;
				}
			},
			// A horizontal band in the upper part of the viewport: whichever section crosses
			// it is "active". Simple, dependency-free scroll spy.
			{ rootMargin: '-25% 0px -65% 0px' }
		);
		for (const { id } of navSections) {
			const el = document.getElementById(id);
			if (el) observer.observe(el);
		}
		return () => observer.disconnect();
	});

	function scrollToSection(event: MouseEvent, id: string) {
		event.preventDefault();
		const el = document.getElementById(id);
		if (!el) return;
		const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
		// SvelteKit's replaceState (not history.replaceState) keeps the router's state in sync.
		replaceState(`#${id}`, {});
		activeSection = id;
	}

	// --- API key state ---
	type Service = 'openai' | 'deepgram' | 'anthropic' | 'elevenlabs';

	interface KeyStatus {
		openai: boolean;
		deepgram: boolean;
		anthropic: boolean;
		elevenlabs: boolean;
	}

	interface KeyStatusResponse extends KeyStatus {
		suffixes?: Partial<Record<Service, string>>;
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
	let keySuffixes = $state<Partial<Record<Service, string>>>({});
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

	let usageData = $state<UsageData | null>(null);
	let loadingUsage = $state(false);

	// How much spoken-card audio is cached durably (R2), so it isn't re-synthesized (re-charged),
	// plus a monitor of recent cache hit/miss outcomes.
	interface TtsCacheInfo {
		clips: number;
		bytes: number;
		pinned_clips: number;
		events: {
			by_status: Array<{ status: string; count: number; chars: number }>;
			hits: number;
			misses: number;
			saved_chars: number;
			spent_chars: number;
			recent: Array<{ status: string; chars: number; created_at: string }>;
		};
	}
	let ttsCache = $state<TtsCacheInfo | null>(null);
	let ttsCacheDetailsLoaded = $state(false);
	let loadingTtsCacheDetails = $state(false);

	/**
	 * Agent conversation usage logged through AnkiTalk this month. ElevenLabs doesn't
	 * expose CAI minutes via API, so this is a local-only tally — see the note rendered
	 * below the figure.
	 */
	let agentUsage = $state<{ month_seconds: number; month_cost_usd: number } | null>(null);
	type AgentReadinessIssue = 'agent_not_configured' | 'agent_not_found' | 'invalid_api_key' | 'insufficient_permissions' | 'agent_auth_disabled' | 'agent_overrides_missing' | 'agent_session_unavailable' | 'mcp_server_not_found' | 'mcp_auth_failed' | 'mcp_not_assigned' | 'mcp_tools_missing' | 'elevenlabs_unavailable';
	interface AgentReadiness {
		ready: boolean;
		issues: AgentReadinessIssue[];
		agent: { configured: boolean; reachable: boolean; authentication_enabled: boolean; session_available: boolean; missing_overrides: string[] };
		mcp: { server_found: boolean; authenticated: boolean; assigned_to_agent: boolean; tools_found: string[]; missing_tools: string[] };
	}
	let agentReadiness = $state<AgentReadiness | null>(null);
	let checkingAgentReadiness = $state(false);
	let loadingAgentConfiguration = $state(true);

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
		if (issue === 'agent_overrides_missing') {
			const labels: Record<string, string> = {
				prompt: $t('settings.agent.readiness.override.prompt'),
				first_message: $t('settings.agent.readiness.override.firstMessage'),
				language: $t('settings.agent.readiness.override.language'),
				voice_id: $t('settings.agent.readiness.override.voice')
			};
			const fields = agentReadiness?.agent.missing_overrides.map((field) => labels[field] ?? field).join(', ') ?? '';
			return $t(`settings.agent.readiness.issues.${issue}`, { fields });
		}
		return $t(`settings.agent.readiness.issues.${issue}`);
	}

	function readinessChecklist(readiness: AgentReadiness): { ok: boolean; text: string }[] {
		return [
			{ ok: readiness.agent.reachable, text: $t('settings.agent.readiness.agent') },
			{ ok: readiness.agent.authentication_enabled, text: $t('settings.agent.readiness.security') },
			{ ok: readiness.agent.missing_overrides.length === 0, text: $t('settings.agent.readiness.overrides') },
			{ ok: readiness.agent.session_available, text: $t('settings.agent.readiness.session') },
			{ ok: readiness.mcp.server_found, text: $t('settings.agent.readiness.server') },
			{ ok: readiness.mcp.authenticated, text: $t('settings.agent.readiness.auth') },
			{ ok: readiness.mcp.assigned_to_agent, text: $t('settings.agent.readiness.assignment') },
			{
				ok: readiness.mcp.authenticated && readiness.mcp.missing_tools.length === 0,
				text: $t('settings.agent.readiness.tools', { count: readiness.mcp.tools_found.length })
			}
		];
	}

	type SetupAction = { issue: AgentReadinessIssue; href: string; external: boolean; labelKey: string };
	function setupAction(readiness: AgentReadiness | null): SetupAction | null {
		const issue = readiness?.issues[0];
		if (!issue) return null;
		if (issue === 'invalid_api_key' || issue === 'insufficient_permissions') {
			return { issue, href: serviceHrefs.elevenlabs, external: true, labelKey: 'settings.agent.readiness.action.apiKey' };
		}
		if (issue === 'agent_not_configured') return null;
		if (issue === 'mcp_server_not_found' || issue === 'mcp_auth_failed') {
			return { issue, href: '#mcp-integration', external: false, labelKey: 'settings.agent.readiness.action.mcp' };
		}
		return { issue, href: 'https://elevenlabs.io/app/agents', external: true, labelKey: 'settings.agent.readiness.action.agent' };
	}
	const nextSetupAction = $derived(setupAction(agentReadiness));

	type ElevenLabsCapability = 'speech_to_text' | 'text_to_speech' | 'voices_read' | 'user_read';
	const elevenLabsCapabilityKeys: Record<ElevenLabsCapability, string> = {
		speech_to_text: 'settings.apiKeys.elevenlabsPerms.stt',
		text_to_speech: 'settings.apiKeys.elevenlabsPerms.tts',
		voices_read: 'settings.apiKeys.elevenlabsPerms.voices',
		user_read: 'settings.apiKeys.elevenlabsPerms.user'
	};

	function elevenLabsPermissionError(capability: unknown): string {
		if (typeof capability !== 'string' || !(capability in elevenLabsCapabilityKeys)) {
			return $t('settings.apiKeys.elevenlabsPermissions');
		}
		return $t('settings.apiKeys.elevenlabsPermissionMissing', {
			permission: $t(elevenLabsCapabilityKeys[capability as ElevenLabsCapability])
		});
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
	let mcpEndpointCopied = $state(false);
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

	async function copyToClipboard(text: string): Promise<boolean> {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			/* clipboard blocked in some browsers — user can still select and copy manually */
			return false;
		}
	}

	async function copyMcpEndpoint() {
		if (!await copyToClipboard(mcpEndpointUrl)) return;
		mcpEndpointCopied = true;
		setTimeout(() => { mcpEndpointCopied = false; }, 2000);
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
				const data = await res.json() as KeyStatusResponse;
				keyStatus = {
					openai: data.openai,
					deepgram: data.deepgram,
					anthropic: data.anthropic,
					elevenlabs: data.elevenlabs
				};
				keySuffixes = data.suffixes ?? {};
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
		loadingAgentConfiguration = false;
		if (keyStatus.elevenlabs && voiceSettings.elevenlabs_agent_id) void checkAgentSetup();

		loadingUsage = true;
		try {
			const [usageRes, agentRes, cacheRes] = await Promise.all([
				fetch('/api/settings/usage'),
				fetch('/api/agent/usage'),
				fetch('/api/settings/tts-cache'),
				loadMcpTokens()
			]);
			if (usageRes.ok) usageData = await usageRes.json() as UsageData;
			if (agentRes.ok) agentUsage = await agentRes.json();
			if (cacheRes.ok) ttsCache = await cacheRes.json() as TtsCacheInfo;
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
		savedFlags.flash('prepareAhead', true);
	}

	async function saveVoiceSettings(nextSettings: UserVoiceSettings, previousSettings: UserVoiceSettings): Promise<boolean> {
		voiceSettings = nextSettings;
		savingVoiceSettings = true;
		try {
			const res = await fetch('/api/settings/voice', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(nextSettings)
			});
			if (!res.ok) throw new Error('Failed to save voice settings');
			const data = await res.json() as { settings: UserVoiceSettings };
			voiceSettings = data.settings;
			if (data.settings.elevenlabs_agent_id !== previousSettings.elevenlabs_agent_id && keyStatus.elevenlabs) void checkAgentSetup();
			return true;
		} catch {
			voiceSettings = previousSettings;
			return false;
		} finally {
			savingVoiceSettings = false;
		}
	}

	async function updateVoiceProvider(provider: VoiceProvider) {
		if (voiceSettings.voice_provider === provider) return;
		const previous = { ...voiceSettings };
		const ok = await saveVoiceSettings(
			{ ...voiceSettings, voice_provider: provider },
			previous
		);
		savedFlags.flash('provider', ok);
	}

	async function updateElevenLabsSettings(partial: Partial<UserVoiceSettings>): Promise<boolean> {
		const previous = { ...voiceSettings };
		return saveVoiceSettings({ ...voiceSettings, ...partial }, previous);
	}

	async function updateVoiceCommandLanguage(language: VoiceCommandLanguage) {
		if (voiceSettings.voice_command_language === language) return;
		const previous = { ...voiceSettings };
		const ok = await saveVoiceSettings(
			{ ...voiceSettings, voice_command_language: language },
			previous
		);
		savedFlags.flash('commandLanguage', ok);
	}

	async function saveAgentId(event: FocusEvent) {
		const next = (event.currentTarget as HTMLInputElement).value.trim() || null;
		if (next === (voiceSettings.elevenlabs_agent_id ?? null)) return;
		const previous = { ...voiceSettings };
		const ok = await saveVoiceSettings({ ...voiceSettings, elevenlabs_agent_id: next }, previous);
		savedFlags.flash('agentId', ok);
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
				keySuffixes[service] = `…${key.slice(-4)}`;
				keyInputs[service] = '';
				expanded[service] = false;
				messages[service] = { text: $t('settings.apiKeys.saved'), ok: true };
				if (service === 'elevenlabs' && voiceSettings.elevenlabs_agent_id) void checkAgentSetup();
			} else {
				const errorBody = await res.json().catch(() => null) as { missing_permission?: unknown } | null;
				if (res.status === 403 && service === 'elevenlabs') {
					messages[service] = { text: elevenLabsPermissionError(errorBody?.missing_permission), ok: false };
					return;
				}
				const errKey = res.status === 429
					? 'settings.apiKeys.rateLimited'
					: res.status === 403 && service === 'deepgram'
						? 'settings.apiKeys.deepgramPermissions'
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
				keySuffixes[service] = undefined;
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

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
		return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	}

	function cacheHitRate(events: TtsCacheInfo['events']): number {
		const total = events.hits + events.misses;
		return total === 0 ? 0 : Math.round((events.hits / total) * 100);
	}

	function formatEventTime(iso: string): string {
		// D1 stores "YYYY-MM-DD HH:MM:SS" in UTC; render a short local time for the debug list.
		const date = new Date(iso.replace(' ', 'T') + 'Z');
		return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
	}

	// Map raw cache-event statuses to human labels + badge tone. Unknown statuses fall
	// back to the raw string so new server states never render as blanks.
	const cacheStatusMeta: Record<string, { labelKey: string; badge: string }> = {
		'edge-hit': { labelKey: 'settings.ttsCache.status.hit', badge: 'badge--success' },
		'r2-hit': { labelKey: 'settings.ttsCache.status.hit', badge: 'badge--success' },
		'inflight-hit': { labelKey: 'settings.ttsCache.status.hit', badge: 'badge--success' },
		'miss': { labelKey: 'settings.ttsCache.status.generated', badge: '' },
		'no-bucket': { labelKey: 'settings.ttsCache.status.noStore', badge: 'badge--warning' },
		'miss-store-failed': { labelKey: 'settings.ttsCache.status.storeFailed', badge: 'badge--danger' },
		'cache-only-miss': { labelKey: 'settings.ttsCache.status.skipped', badge: 'badge--warning' }
	};

	function cacheStatusLabel(status: string): string {
		const meta = cacheStatusMeta[status];
		return meta ? $t(meta.labelKey) : status;
	}

	function cacheStatusBadge(status: string): string {
		return cacheStatusMeta[status]?.badge ?? '';
	}

	// Several raw statuses share one human label (edge/R2/in-flight hits are all "served
	// from cache"), so aggregate counts per label for the summary chips.
	function cacheBreakdown(byStatus: TtsCacheInfo['events']['by_status']): { label: string; badge: string; count: number }[] {
		const groups = new Map<string, { label: string; badge: string; count: number }>();
		for (const s of byStatus) {
			const label = cacheStatusLabel(s.status);
			const existing = groups.get(label);
			if (existing) existing.count += s.count;
			else groups.set(label, { label, badge: cacheStatusBadge(s.status), count: s.count });
		}
		return [...groups.values()];
	}

	function allZero(usage: UsageData): boolean {
		return usage.today.total === 0 && usage.week.total === 0 && usage.month.total === 0;
	}

	async function onCacheDetailsToggle(event: Event) {
		const open = (event.currentTarget as HTMLDetailsElement).open;
		if (!open || !ttsCache || ttsCacheDetailsLoaded || loadingTtsCacheDetails) return;
		loadingTtsCacheDetails = true;
		try {
			const res = await fetch('/api/settings/tts-cache?includeRecent=1');
			if (res.ok) {
				ttsCache = await res.json() as TtsCacheInfo;
				ttsCacheDetailsLoaded = true;
			}
		} catch {
			// Keep the summary visible if the optional detail fetch fails.
		} finally {
			loadingTtsCacheDetails = false;
		}
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

	function keyToggleLabel(service: Service): string {
		if (expanded[service]) return $t('common.close');
		return keyStatus[service] ? $t('settings.apiKeys.edit') : $t('settings.apiKeys.add');
	}
</script>

{#snippet iconPlus()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
{/snippet}

{#snippet iconEdit()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
{/snippet}

{#snippet iconClose()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
{/snippet}

{#snippet iconCopy()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
{/snippet}

{#snippet iconCheck()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
{/snippet}

{#snippet iconTrash()}
	<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m19 6-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></svg>
{/snippet}

<!-- One row per API key service, shared by the "voice review" and "advanced providers"
     lists: configured badge + masked suffix, expand/edit, save-on-Enter, remove. -->
{#snippet keyRow(service: Service)}
	<div class="key-row">
		<div class="key-row-header">
			<div class="key-row-info">
				<span class="key-service-name">{serviceLabel(service)}</span>
				<span class="key-service-desc">{serviceDesc(service)}</span>
				<span class="key-service-cost">{serviceCost(service)}</span>
			</div>
			<div class="key-row-actions">
				{#if keyStatus[service]}
					<span class="key-badge-group">
						<span class="badge badge--success">{$t('settings.apiKeys.configured')}</span>
						{#if keySuffixes[service]}
							<code class="key-suffix">{keySuffixes[service]}</code>
						{/if}
					</span>
				{:else}
					<span class="badge">{$t('settings.apiKeys.notConfigured')}</span>
				{/if}
				<button
					class="action-btn icon-btn"
					type="button"
					onclick={() => toggleExpanded(service)}
					aria-label={keyToggleLabel(service)}
					title={keyToggleLabel(service)}
				>
					{#if expanded[service]}
						{@render iconClose()}
					{:else if keyStatus[service]}
						{@render iconEdit()}
					{:else}
						{@render iconPlus()}
					{/if}
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
{/snippet}

{#key current}
<div class="settings-page" style="--nav-offset: {navOffset}px">
	<a href="/" class="back-link">&larr; {$t('appSettings.dashboard')}</a>

	<h1>{$t('appSettings.title')}</h1>

	<nav class="section-nav" aria-label={$t('settings.nav.label')}>
		{#each navSections as sectionLink (sectionLink.id)}
			<a
				href="#{sectionLink.id}"
				class:active={activeSection === sectionLink.id}
				aria-current={activeSection === sectionLink.id ? 'true' : undefined}
				onclick={(e) => scrollToSection(e, sectionLink.id)}
			>
				{$t(sectionLink.labelKey)}
			</a>
		{/each}
	</nav>

	<section class="section card" id="section-language">
		<h2>{$t('appSettings.language')}</h2>
		<div class="segmented-control" role="group" aria-label={$t('appSettings.language')}>
			<button
				class="segment-option"
				class:active={current === 'en'}
				aria-pressed={current === 'en'}
				onclick={() => setLocale('en')}
			>
				<span>English</span>
			</button>
			<button
				class="segment-option"
				class:active={current === 'de'}
				aria-pressed={current === 'de'}
				onclick={() => setLocale('de')}
			>
				<span>Deutsch</span>
			</button>
		</div>
	</section>

	<section class="section card" id="section-keys">
		<h2>{$t('settings.apiKeys.title')}</h2>
		<p class="section-desc">{$t('settings.apiKeys.description')}</p>

		<h3 class="subsection-label">{$t('settings.apiKeys.voiceSection')}</h3>
		{#each primaryServices as service}
			{@render keyRow(service)}
		{/each}

		<h3 class="subsection-label subsection-label--optional">{$t('settings.apiKeys.advancedSection')}</h3>
		<p class="section-desc">{$t('settings.apiKeys.advancedDesc')}</p>
		{#each advancedServices as service}
			{@render keyRow(service)}
		{/each}
	</section>

	<section class="section card" id="section-audio">
		<h2>{$t('appSettings.audio')}</h2>
		<div class="voice-provider-group" aria-label={$t('settings.voice.title')}>
			<div class="voice-provider-copy">
				<span class="preference-title">{$t('settings.voice.title')} <SavedFlag status={savedFlags.get('provider')} /></span>
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
				<span class="preference-title">{$t('settings.voice.commandLanguage')} <SavedFlag status={savedFlags.get('commandLanguage')} /></span>
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
				<span class="preference-title">{$t('appSettings.prepareAudioAhead')} <SavedFlag status={savedFlags.get('prepareAhead')} /></span>
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

	<section class="section card" id="section-tutor">
		<h2>
			{$t('settings.agent.title')}
			{#if loadingAgentConfiguration || checkingAgentReadiness}
				<span class="badge">{$t('settings.agent.readiness.checking')}</span>
			{:else if agentReadiness?.ready}
				<span class="badge badge--success">{$t('settings.apiKeys.configured')}</span>
			{:else}
				<span class="badge">{$t('settings.apiKeys.notConfigured')}</span>
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
				<li>{$t('settings.agent.setupStep5')}</li>
			</ol>
			<p class="agent-help agent-help--warn">{$t('settings.agent.setupScopeWarning')}</p>
		</details>

		<label class="agent-field">
			<span class="agent-label">{$t('settings.agent.agentIdLabel')} <SavedFlag status={savedFlags.get('agentId')} /></span>
			<input
				type="text"
				class="agent-input"
				placeholder={$t('settings.agent.agentIdPlaceholder')}
				value={voiceSettings.elevenlabs_agent_id ?? ''}
				onblur={saveAgentId}
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
				{@const checklist = readinessChecklist(agentReadiness)}
				{@const stepsLeft = checklist.filter((step) => !step.ok).length}
				<p class="readiness-status" class:readiness-status--ready={stepsLeft === 0}>
					{#if stepsLeft === 0}
						✓ {$t('settings.agent.readiness.ready')}
					{:else}
						{stepsLeft === 1
							? $t('settings.agent.readiness.oneStepLeft')
							: $t('settings.agent.readiness.stepsLeft', { count: stepsLeft })}
					{/if}
				</p>
				{#if nextSetupAction}
					<div class="agent-readiness-next">
						<strong>{$t('settings.agent.readiness.nextStep')}</strong>
						<p>{readinessIssueText(nextSetupAction.issue)}</p>
						<a
							class="action-btn agent-readiness-action"
							href={nextSetupAction.href}
							target={nextSetupAction.external ? '_blank' : undefined}
							rel={nextSetupAction.external ? 'noopener noreferrer' : undefined}
						>
							{$t(nextSetupAction.labelKey)} →
						</a>
					</div>
				{/if}
				{#if agentReadiness.issues.length && !nextSetupAction}
					<div class="agent-readiness-issues">
						{#each agentReadiness.issues as issue}<p>{readinessIssueText(issue)}</p>{/each}
					</div>
				{:else if agentReadiness.issues.length > 1}
					<div class="agent-readiness-issues">
						{#each agentReadiness.issues.slice(1) as issue}<p>{readinessIssueText(issue)}</p>{/each}
					</div>
				{/if}
				<details class="disclosure">
					<summary>{$t('settings.agent.readiness.showChecklist')}</summary>
					<ul class="agent-readiness-list">
						{#each checklist as step}
							<li class:ok={step.ok}>{step.ok ? '✓' : '○'} {step.text}</li>
						{/each}
					</ul>
				</details>
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

		<div class="agent-tuning">
			<strong>{$t('settings.agent.tuningTitle')}</strong>
			<p>{$t('settings.agent.tuningDesc')}</p>
			<p class="agent-help">
				<a href="https://elevenlabs.io/app/agents" target="_blank" rel="noopener noreferrer">
					{$t('settings.agent.tuningDashboardLink')} →
				</a>
			</p>
			<p class="agent-help">
				<a href="https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow" target="_blank" rel="noopener noreferrer">
					{$t('settings.agent.tuningDocsLink')} →
				</a>
			</p>
		</div>
	</section>

	<section class="section card" id="mcp-integration">
		<h2>{$t('settings.mcp.title')}</h2>
		<p class="section-desc">{$t('settings.mcp.desc')}</p>

		<div class="mcp-endpoint">
			<span class="agent-label">{$t('settings.mcp.endpointLabel')}</span>
			<div class="mcp-endpoint-row">
				<input type="text" class="agent-input mcp-endpoint-input" value={mcpEndpointUrl} readonly />
				<button
					class="action-btn icon-btn"
					type="button"
					onclick={copyMcpEndpoint}
					aria-label={$t('settings.mcp.copy')}
					title={mcpEndpointCopied ? $t('settings.mcp.copied') : $t('settings.mcp.copy')}
				>
					{#if mcpEndpointCopied}{@render iconCheck()}{:else}{@render iconCopy()}{/if}
				</button>
			</div>
		</div>
		<p class="agent-help">{$t('settings.mcp.endpointHelp')}</p>

		<div class="mcp-oauth">
			<strong>{$t('settings.mcp.oauthTitle')}</strong>
			<p class="agent-help">{$t('settings.mcp.oauthDesc')}</p>
			<ol class="agent-setup-steps">
				<li>{$t('settings.mcp.oauth1')}</li>
				<li>{$t('settings.mcp.oauth2')}</li>
				<li>{$t('settings.mcp.oauth3')}</li>
			</ol>
		</div>

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
					<button
						class="action-btn icon-btn"
						type="button"
						onclick={() => copyToClipboard(mcpTokenJustCreated ?? '')}
						aria-label={$t('settings.mcp.copy')}
						title={$t('settings.mcp.copy')}
					>
						{@render iconCopy()}
					</button>
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
						<div class="mcp-token-main">
							<div class="mcp-token-line1">
								<code class="mcp-token-prefix">{tok.prefix}…</code>
								{#if tok.label}<span class="mcp-token-label">{tok.label}</span>{/if}
								<span class="badge">{tok.scopes.includes('cards:write') ? $t('settings.mcp.profileAuthor') : $t('settings.mcp.profileStudy')}</span>
							</div>
							<div class="mcp-token-line2">
								<span>{$t('settings.mcp.createdAt', { date: tok.created_at })}</span>
								{#if tok.expires_at}<span>{$t('settings.mcp.expiresAt', { date: tok.expires_at })}</span>{/if}
								{#if tok.last_used_at}
									<span>{$t('settings.mcp.lastUsedAt', { date: tok.last_used_at })}</span>
								{:else}
									<span>{$t('settings.mcp.neverUsed')}</span>
								{/if}
							</div>
						</div>
						<button
							class="action-btn icon-btn"
							type="button"
							onclick={() => revokeMcpToken(tok.id)}
							aria-label={$t('settings.mcp.revoke')}
							title={$t('settings.mcp.revoke')}
						>
							{@render iconTrash()}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="section card" id="section-usage">
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
							<span data-label={$t('settings.usage.today')}>{formatCost(usageData!.today[s as Service])}</span>
							<span data-label={$t('settings.usage.week')}>{formatCost(usageData!.week[s as Service])}</span>
							<span data-label={$t('settings.usage.month')}>{formatCost(usageData!.month[s as Service])}</span>
						</div>
					{/each}
					<div class="usage-row usage-row--total">
						<span class="usage-service">{$t('settings.usage.total')}</span>
						<span data-label={$t('settings.usage.today')}>{formatCost(usageData!.today.total)}</span>
						<span data-label={$t('settings.usage.week')}>{formatCost(usageData!.week.total)}</span>
						<span data-label={$t('settings.usage.month')}>{formatCost(usageData!.month.total)}</span>
					</div>
				</div>
			</div>
			<p class="usage-note">{$t('settings.usage.note')}</p>
		{/if}

		{#if ttsCache && (ttsCache.clips > 0 || ttsCache.events.hits + ttsCache.events.misses > 0)}
			<div class="tts-cache">
				<div class="tts-cache-head">
					<strong>{$t('settings.ttsCache.title')}</strong>
					<span class="tts-cache-size">{$t('settings.ttsCache.summary', { clips: ttsCache.clips, size: formatBytes(ttsCache.bytes) })}</span>
				</div>
				<p class="tts-cache-note">
					{$t('settings.ttsCache.note')}
					{#if ttsCache.pinned_clips > 0}
						{' '}{$t('settings.ttsCache.pinned', { count: ttsCache.pinned_clips })}
					{/if}
				</p>

				{#if ttsCache.events.hits + ttsCache.events.misses > 0}
					<div class="cache-monitor">
						<div class="cache-monitor-summary">
							<span>{$t('settings.ttsCache.hitRate', { pct: cacheHitRate(ttsCache.events) })}</span>
							<span>{$t('settings.ttsCache.saved', { chars: ttsCache.events.saved_chars })}</span>
						</div>
						<div class="cache-monitor-breakdown">
							{#each cacheBreakdown(ttsCache.events.by_status) as group (group.label)}
								<span class="badge {group.badge}">{group.label}: {group.count}</span>
							{/each}
						</div>
						<details class="disclosure" ontoggle={onCacheDetailsToggle}>
							<summary>{$t('settings.ttsCache.diagnostics')}</summary>
							{#if loadingTtsCacheDetails}
								<div class="cache-monitor-loading">{$t('settings.ttsCache.loadingRecent')}</div>
							{:else if ttsCache.events.recent.length > 0}
								<div class="cache-monitor-table-wrap">
									<table class="cache-monitor-table">
										<thead>
											<tr>
												<th>{$t('settings.ttsCache.colWhen')}</th>
												<th>{$t('settings.ttsCache.colStatus')}</th>
												<th class="num">{$t('settings.ttsCache.colChars')}</th>
											</tr>
										</thead>
										<tbody>
											{#each ttsCache.events.recent as ev}
												<tr>
													<td>{formatEventTime(ev.created_at)}</td>
													<td><span class="badge {cacheStatusBadge(ev.status)}">{cacheStatusLabel(ev.status)}</span></td>
													<td class="num">{ev.chars}</td>
												</tr>
											{/each}
										</tbody>
									</table>
								</div>
							{/if}
							<p class="cache-monitor-note">{$t('settings.ttsCache.monitorNote')}</p>
						</details>
					</div>
				{/if}
			</div>
		{/if}
	</section>

	<section class="section card" id="section-account">
		<h2>{$t('settings.account.title')}</h2>
		<button class="logout-btn" type="button" onclick={logout} disabled={loggingOut}>
			{#if loggingOut}<Spinner size={14} />{/if}
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
			{$t('nav.logout')}
		</button>
	</section>
</div>
{/key}


<style>
	.settings-page {
		max-width: 520px;
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
		margin: 1rem 0 0.75rem;
		font-size: 1.4rem;
	}

	/* Sticky in-page section nav: a horizontally scrollable pill row that sits directly
	   under the app's sticky top nav (offset measured into --nav-offset). */
	.section-nav {
		position: sticky;
		top: var(--nav-offset, 61px);
		z-index: 30;
		display: flex;
		gap: 0.35rem;
		overflow-x: auto;
		scrollbar-width: none;
		margin: 0 -1rem 1.25rem;
		padding: 0.5rem 1rem;
		background: rgba(10, 10, 10, 0.85);
		-webkit-backdrop-filter: blur(12px);
		backdrop-filter: blur(12px);
	}

	.section-nav::-webkit-scrollbar {
		display: none;
	}

	.section-nav a {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		padding: 0.35rem 0.9rem;
		border: 1px solid transparent;
		border-radius: var(--r-pill);
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-muted);
		text-decoration: none;
		white-space: nowrap;
		touch-action: manipulation;
		transition:
			color var(--t-fast) var(--ease),
			background var(--t-fast) var(--ease),
			border-color var(--t-fast) var(--ease);
	}

	.section-nav a:hover {
		color: var(--text);
	}

	.section-nav a.active {
		color: var(--text);
		background: var(--surface-elevated);
		border-color: var(--border);
	}

	/* Grouped iOS-Settings-style cards; .card (app.css) supplies surface/border/radius.
	   scroll-margin keeps anchored sections clear of both sticky bars. */
	.section {
		padding: 1.1rem 1.15rem 1.2rem;
		margin-bottom: 1rem;
		scroll-margin-top: calc(var(--nav-offset, 61px) + 4.5rem);
	}

	.section h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
		font-size: 1.02rem;
		color: var(--text);
		margin: 0 0 0.75rem;
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

	.voice-provider-group,
	.voice-language-group {
		margin-bottom: 1rem;
	}

	.voice-provider-copy {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin-bottom: 0.6rem;
	}

	/* Radio-card idiom: descriptive, mutually exclusive options. */
	.provider-options {
		display: grid;
		gap: 0.5rem;
	}

	.provider-option {
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

	.provider-option:hover {
		border-color: var(--border-strong);
	}

	.provider-option.active {
		border-color: var(--primary);
		background: var(--surface-elevated);
	}

	.provider-option input {
		margin-top: 0.15rem;
		accent-color: var(--primary);
	}

	.provider-option span {
		display: flex;
		flex-direction: column;
		gap: 0.18rem;
	}

	.provider-option strong {
		font-size: 0.9rem;
		color: var(--text);
	}

	.provider-option small {
		font-size: 0.78rem;
		line-height: 1.35;
		color: var(--text-muted);
	}

	/* Segmented-control idiom: 2–3 short, mutually exclusive options. auto-fit lets long
	   German labels wrap onto a second row instead of overflowing fixed thirds. */
	.segmented-control {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr));
		gap: 0.3rem;
		padding: 0.25rem;
		border: 1px solid var(--border-muted);
		border-radius: var(--r-md);
		background: var(--surface-2);
	}

	.segment-option {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 0;
		min-height: 44px;
		padding: 0.45rem 0.5rem;
		border: 1px solid transparent;
		border-radius: var(--r-sm);
		background: none;
		color: var(--text-muted);
		text-align: center;
		cursor: pointer;
		font-family: inherit;
		font-size: 0.85rem;
		font-weight: 600;
		touch-action: manipulation;
		transition:
			background var(--t-fast) var(--ease),
			color var(--t-fast) var(--ease),
			border-color var(--t-fast) var(--ease);
	}

	.segment-option:hover {
		color: var(--text);
	}

	.segment-option.active {
		background: var(--surface-elevated);
		border-color: var(--primary);
		color: var(--text);
	}

	.segment-option input {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	.segment-option span {
		display: block;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.preference-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		background: var(--surface-2);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-md);
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
		color: var(--text);
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
		accent-color: var(--primary);
		cursor: pointer;
	}

	/* Key rows */
	.key-row {
		background: var(--surface-2);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-md);
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
		color: var(--text);
	}

	.key-service-desc {
		font-size: 0.82rem;
		color: var(--text-subtle);
	}

	.key-service-cost {
		font-size: 0.78rem;
		color: var(--text-subtle);
	}

	.key-row-actions {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex-shrink: 0;
	}

	.key-badge-group {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
	}

	/* Masked last-4 preview of the stored key, next to the Configured badge. */
	.key-suffix {
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--text-subtle);
		white-space: nowrap;
	}

	.action-btn {
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text-muted);
		border-radius: var(--r-sm);
		cursor: pointer;
		font-size: 0.82rem;
		font-weight: 600;
		min-width: 2.5rem;
		min-height: 2.5rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		transition:
			border-color var(--t-fast) var(--ease),
			color var(--t-fast) var(--ease);
		padding: 0 0.75rem;
		max-width: 100%;
		line-height: 1.2;
		text-align: center;
		-webkit-tap-highlight-color: rgba(255, 255, 255, 0.12);
		touch-action: manipulation;
	}

	.action-btn:hover {
		border-color: var(--border-strong);
		color: var(--text);
	}

	.icon-btn {
		width: 2.5rem;
		min-width: 2.5rem;
		height: 2.5rem;
		padding: 0;
		flex: 0 0 auto;
		white-space: nowrap;
	}

	.icon-btn svg,
	.logout-btn svg {
		width: 1rem;
		height: 1rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.key-message {
		font-size: 0.82rem;
		margin: 0.5rem 0 0;
		padding: 0.4rem 0.6rem;
		border-radius: var(--r-sm);
	}

	.key-message--ok {
		background: var(--success-tint);
		color: var(--success);
	}

	.key-message--err {
		background: var(--danger-tint);
		color: var(--danger-soft);
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
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: var(--r-sm);
		color: var(--text);
		font-size: 0.9rem;
		font-family: var(--font-mono);
		box-sizing: border-box;
		transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
	}

	.key-input:focus {
		outline: none;
		border-color: var(--border-strong);
		box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.06);
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
		background: var(--bg);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-sm);
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
		color: var(--text-muted);
		line-height: 1.35;
	}

	.key-link-hint {
		font-size: 0.78rem;
		color: var(--text-subtle);
	}

	.key-link-hint a {
		color: var(--text-muted);
		text-decoration: underline;
		/* Long provider URLs (console.anthropic.com/..., elevenlabs.io/...) would otherwise
		   force the whole settings page to scroll horizontally on a 320–375px viewport. */
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.key-link-hint a:hover {
		color: var(--text);
	}

	.usage-loading {
		display: flex;
		justify-content: center;
		padding: 1.5rem 0;
		color: var(--text-muted);
	}

	/* Usage table */
	.usage-table-wrap {
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
		margin-bottom: 0.75rem;
		border-radius: var(--r-md);
	}

	.usage-table {
		border: 1px solid var(--border-muted);
		border-radius: var(--r-md);
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
		color: var(--text-subtle);
		text-align: right;
	}

	.usage-head span:first-child {
		text-align: left;
	}

	.usage-row + .usage-row {
		border-top: 1px solid var(--border-muted);
	}

	.usage-row span {
		padding: 0.55rem 0.65rem;
		font-size: 0.85rem;
		color: var(--text-muted);
		text-align: right;
	}

	.usage-row span.usage-service {
		text-align: left;
		color: var(--text);
		font-size: 0.82rem;
	}

	.usage-row--total {
		background: var(--surface-2);
	}

	.usage-row--total span {
		font-weight: 600;
		color: var(--text);
	}

	.usage-note {
		font-size: 0.78rem;
		color: var(--text-subtle);
		margin: 0;
		line-height: 1.5;
	}

	/* Under 600px the four-column table becomes stacked per-service cards; the column
	   headers are re-created from data-label attributes. */
	@media (max-width: 600px) {
		.usage-table-wrap {
			overflow-x: visible;
		}

		.usage-table {
			min-width: 0;
			border: none;
			border-radius: 0;
			overflow: visible;
			display: flex;
			flex-direction: column;
			gap: 0.6rem;
		}

		.usage-head {
			display: none;
		}

		.usage-table .usage-row {
			grid-template-columns: repeat(3, 1fr);
			border: 1px solid var(--border-muted);
			border-radius: var(--r-md);
			background: var(--surface-2);
			padding: 0.35rem 0.25rem 0.4rem;
		}

		.usage-table .usage-row span.usage-service {
			grid-column: 1 / -1;
			padding-bottom: 0.15rem;
		}

		.usage-table .usage-row span[data-label] {
			text-align: left;
			padding-top: 0.15rem;
		}

		.usage-table .usage-row span[data-label]::before {
			content: attr(data-label);
			display: block;
			font-size: 0.66rem;
			font-weight: 600;
			text-transform: uppercase;
			letter-spacing: 0.05em;
			color: var(--text-subtle);
			margin-bottom: 0.1rem;
		}

		.usage-table .usage-row--total {
			background: var(--surface-elevated);
		}
	}

	.tts-cache {
		margin-top: 1rem;
		padding: 0.75rem 1rem;
		background: var(--surface-2);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-md);
	}

	.tts-cache-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}

	.tts-cache-size {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.tts-cache-note {
		font-size: 0.78rem;
		color: var(--text-subtle);
		margin: 0.4rem 0 0;
		line-height: 1.5;
	}

	.cache-monitor {
		margin-top: 0.85rem;
		padding-top: 0.85rem;
		border-top: 1px solid var(--border-muted);
	}

	.cache-monitor-summary {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--text);
		margin-bottom: 0.6rem;
	}

	.cache-monitor-breakdown {
		display: flex;
		gap: 0.4rem;
		flex-wrap: wrap;
		margin-bottom: 0.3rem;
	}

	/* Plain-text disclosure used for the readiness checklist and cache diagnostics. */
	.disclosure {
		margin-top: 0.4rem;
	}

	.disclosure summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		cursor: pointer;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-muted);
		list-style: none;
		-webkit-tap-highlight-color: rgba(255, 255, 255, 0.12);
	}

	.disclosure summary::-webkit-details-marker {
		display: none;
	}

	.disclosure summary::before {
		content: '▸';
		margin-right: 0.35rem;
		color: var(--text-subtle);
	}

	.disclosure[open] summary::before {
		content: '▾';
	}

	.disclosure summary:hover {
		color: var(--text);
	}

	.cache-monitor-loading {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin-bottom: 0.5rem;
	}

	.cache-monitor-table-wrap {
		overflow-x: auto;
		-webkit-overflow-scrolling: touch;
	}

	.cache-monitor-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.75rem;
	}

	.cache-monitor-table th,
	.cache-monitor-table td {
		text-align: left;
		padding: 0.3rem 0.4rem;
		border-bottom: 1px solid var(--border-muted);
		color: var(--text-muted);
		white-space: nowrap;
	}

	.cache-monitor-table th {
		color: var(--text-subtle);
		font-weight: 600;
	}

	.cache-monitor-table .num {
		text-align: right;
	}

	.cache-monitor-note {
		font-size: 0.72rem;
		color: var(--text-subtle);
		margin: 0.5rem 0 0;
		line-height: 1.5;
	}

	.muted {
		color: var(--text-subtle);
		font-size: 0.88rem;
	}

	/* Conversational tutor (Lernen agent) settings block. */
	.agent-field { display: block; margin: 0.8rem 0 0.4rem; }
	.agent-label {
		display: flex; align-items: center; gap: 0.5rem;
		font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.3rem; font-weight: 600;
	}
	.agent-input {
		width: 100%; box-sizing: border-box;
		padding: 0.55rem 0.7rem; border-radius: var(--r-sm);
		background: var(--bg); border: 1px solid var(--border); color: var(--text);
		font-size: 0.95rem; font-family: var(--font-mono);
		transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
	}
	.agent-input:focus {
		outline: none;
		border-color: var(--border-strong);
		box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.06);
	}
	.agent-help { font-size: 0.78rem; color: var(--text-muted); margin: 0.3rem 0; line-height: 1.4; }
	.agent-help a { color: var(--text); text-decoration: underline; }
	.agent-usage {
		margin-top: 1rem; padding: 0.7rem 0.85rem;
		background: var(--surface-2); border: 1px solid var(--border-muted);
		border-radius: var(--r-md);
	}
	.agent-tuning {
		margin-top: 1rem; padding: 0.7rem 0.85rem;
		background: var(--surface-2); border: 1px solid var(--border-muted);
		border-radius: var(--r-md);
		font-size: 0.9rem; color: var(--text);
	}
	.agent-tuning strong { display: block; margin-bottom: 0.35rem; }
	.agent-tuning p { margin: 0.35rem 0 0; color: var(--text-muted); }
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
		background: var(--surface-2);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-sm);
		padding: 0.55rem 0.8rem;
	}
	.agent-setup summary {
		cursor: pointer; font-size: 0.85rem; color: var(--text); font-weight: 600;
		list-style: none;
		min-height: 32px; display: flex; align-items: center;
	}
	.agent-setup summary::-webkit-details-marker { display: none; }
	.agent-setup summary::before { content: '▸'; margin-right: 0.35rem; color: var(--text-muted); }
	.agent-setup[open] summary::before { content: '▾'; }
	.agent-setup-steps {
		margin: 0.6rem 0 0.3rem 1.1rem; padding: 0;
		font-size: 0.84rem; color: var(--text-muted); line-height: 1.55;
	}
	.agent-setup-steps li { margin-bottom: 0.25rem; }
	.agent-setup-steps a { color: var(--text); text-decoration: underline; }
	.agent-help--warn { color: var(--warning); }

	/* MCP-specific styling: endpoint URL field, tokens list. */
	.mcp-oauth {
		margin: 0.6rem 0 0.8rem;
		background: var(--surface-2);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-sm);
		padding: 0.7rem 0.85rem;
	}
	.mcp-oauth strong { font-size: 0.85rem; color: var(--text); }
	.mcp-oauth .agent-help { margin: 0.3rem 0 0.5rem; }
	.mcp-endpoint { display: block; margin: 0.4rem 0 0.3rem; }
	.mcp-endpoint-row { display: flex; align-items: center; gap: 0.45rem; min-width: 0; }
	.mcp-endpoint-input { min-width: 0; font-size: 0.8rem; }
	.mcp-tokens-head {
		display: flex; align-items: center; justify-content: space-between;
		gap: 0.75rem; margin: 0.9rem 0 0.5rem;
	}
	.mcp-token-create-controls { display: flex; align-items: center; gap: 0.45rem; min-width: 0; }
	.mcp-profile-select { width: auto; min-width: 150px; font-size: 0.78rem; padding: 0.42rem 0.55rem; }
	.mcp-fresh {
		background: var(--warning-tint); border: 1px solid var(--warning-border);
		border-radius: var(--r-sm); padding: 0.7rem; margin-bottom: 0.7rem;
		display: flex; flex-direction: column; gap: 0.5rem;
	}
	.mcp-fresh-warn { font-size: 0.82rem; color: var(--warning); margin: 0; font-weight: 600; }
	.mcp-fresh-row { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
	.mcp-fresh-token {
		flex: 1; min-width: 0;
		font-family: var(--font-mono); font-size: 0.78rem;
		padding: 0.4rem 0.55rem;
		background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm);
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.mcp-tokens { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.45rem; }

	/* Calm two-line token cards: identity on line 1, muted timestamps on line 2. */
	.mcp-token {
		display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;
		padding: 0.6rem 0.75rem;
		background: var(--surface-2); border: 1px solid var(--border-muted); border-radius: var(--r-md);
	}
	.mcp-token-main { display: flex; flex-direction: column; gap: 0.3rem; flex: 1; min-width: 0; }
	.mcp-token-line1 { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
	.mcp-token-prefix { font-family: var(--font-mono); font-size: 0.85rem; color: var(--text); }
	.mcp-token-label { color: var(--text-muted); font-size: 0.85rem; }
	.mcp-token-line2 {
		display: flex; flex-wrap: wrap; gap: 0.2rem 0.75rem;
		font-size: 0.75rem; color: var(--text-subtle);
	}

	.agent-readiness { margin: 1rem 0; padding: 0.9rem; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface-2); }
	.agent-readiness--ready { border-color: var(--success-border); }
	.agent-readiness-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.75rem; }
	.agent-readiness-head p { margin: 0.2rem 0 0; color: var(--text-muted); font-size: 0.82rem; }

	/* One-line readiness summary replacing the always-open eight-row checklist. */
	.readiness-status {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		margin: 0.75rem 0 0;
		padding: 0.3rem 0.7rem;
		border-radius: var(--r-pill);
		font-size: 0.82rem;
		font-weight: 600;
		background: var(--warning-tint);
		color: var(--warning);
		border: 1px solid var(--warning-border);
	}

	.readiness-status--ready {
		background: var(--success-tint);
		color: var(--success);
		border-color: var(--success-border);
	}

	.agent-readiness-list { list-style: none; padding: 0; margin: 0.5rem 0 0; display: grid; gap: 0.35rem; font-size: 0.82rem; color: var(--text-muted); }
	.agent-readiness-list li.ok { color: var(--success); }
	.agent-readiness-issues { margin-top: 0.75rem; padding: 0.65rem; border-radius: var(--r-sm); background: var(--warning-tint); }
	.agent-readiness-issues p { margin: 0.2rem 0; font-size: 0.8rem; color: var(--text); }
	.agent-readiness-next { margin-top: 0.75rem; padding: 0.75rem; border-radius: var(--r-sm); background: var(--surface-elevated); border: 1px solid var(--border); }
	.agent-readiness-next p { margin: 0.25rem 0 0.65rem; font-size: 0.82rem; color: var(--text); line-height: 1.45; }
	.agent-readiness-action { display: inline-flex; width: fit-content; text-decoration: none; }

	@media (max-width: 520px) {
		.agent-readiness-head { flex-direction: column; }
		.agent-readiness-head .action-btn { width: 100%; justify-content: center; }
		.agent-readiness-action { width: 100%; justify-content: center; }
		.mcp-token-create-controls { width: 100%; flex-direction: column; align-items: stretch; }
		.mcp-token-create-controls .action-btn { width: 100%; }
		.mcp-profile-select { width: 100%; }
		.mcp-tokens-head { align-items: stretch; flex-direction: column; gap: 0.55rem; }
		.key-row-header { align-items: flex-start; }
		.key-row-actions { flex-direction: column-reverse; align-items: flex-end; gap: 0.35rem; }
		.key-input-footer .btn-primary { width: 100%; justify-content: center; }
	}

	.logout-btn {
		display: inline-flex; align-items: center; gap: 0.5rem;
		background: none; color: var(--danger-soft);
		border: 1px solid var(--border-muted); border-radius: var(--r-pill);
		padding: 0.6rem 1.1rem; font-size: 0.9rem; font-weight: 600;
		cursor: pointer; min-height: 44px; touch-action: manipulation;
	}
	.logout-btn:hover:not(:disabled) { border-color: var(--danger-soft); color: var(--text); }
	.logout-btn:disabled { opacity: 0.6; cursor: default; }
</style>

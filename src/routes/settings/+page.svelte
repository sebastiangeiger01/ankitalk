<script lang="ts">
	import { onMount } from 'svelte';
	import { locale, t, type Locale } from '$lib/i18n';

	function setLocale(l: Locale) {
		locale.set(l);
	}

	let current = $state<Locale>('en');
	$effect(() => {
		return locale.subscribe((v) => { current = v; });
	});

	// --- API key state ---
	type Service = 'openai' | 'deepgram' | 'anthropic';

	interface KeyStatus {
		openai: boolean;
		deepgram: boolean;
		anthropic: boolean;
	}

	interface UsagePeriod {
		openai: number;
		deepgram: number;
		anthropic: number;
		total: number;
	}

	interface UsageData {
		today: UsagePeriod;
		week: UsagePeriod;
		month: UsagePeriod;
	}

	let keyStatus = $state<KeyStatus>({ openai: false, deepgram: false, anthropic: false });
	let keyInputs = $state<Record<Service, string>>({ openai: '', deepgram: '', anthropic: '' });
	let expanded = $state<Record<Service, boolean>>({ openai: false, deepgram: false, anthropic: false });
	let saving = $state<Record<Service, boolean>>({ openai: false, deepgram: false, anthropic: false });
	let removing = $state<Record<Service, boolean>>({ openai: false, deepgram: false, anthropic: false });
	let messages = $state<Record<Service, { text: string; ok: boolean } | null>>({
		openai: null,
		deepgram: null,
		anthropic: null,
	});

	let usageData = $state<UsageData | null>(null);
	let loadingUsage = $state(false);

	const serviceLinks: Record<Service, string> = {
		openai: 'platform.openai.com/api-keys',
		deepgram: 'console.deepgram.com',
		anthropic: 'console.anthropic.com/settings/keys',
	};

	const serviceHrefs: Record<Service, string> = {
		openai: 'https://platform.openai.com/api-keys',
		deepgram: 'https://console.deepgram.com',
		anthropic: 'https://console.anthropic.com/settings/keys',
	};

	onMount(async () => {
		try {
			const res = await fetch('/api/settings/api-keys');
			if (res.ok) {
				const data = await res.json();
				keyStatus = data;
			}
		} catch {
			// silently ignore — keys stay as not configured
		}

		loadingUsage = true;
		try {
			const res = await fetch('/api/settings/usage');
			if (res.ok) {
				usageData = await res.json();
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
				messages[service] = { text: t('settings.apiKeys.invalid'), ok: false };
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

	const requiredServices: Service[] = ['openai', 'deepgram'];
	const optionalServices: Service[] = ['anthropic'];

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
		<h2>{t('settings.apiKeys.title')}</h2>
		<p class="section-desc">{t('settings.apiKeys.description')}</p>

		<h3 class="subsection-label">{t('settings.apiKeys.requiredSection')}</h3>
		{#each requiredServices as service}
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
							{removing[service] ? '...' : t('settings.apiKeys.remove')}
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
								{saving[service] ? t('settings.apiKeys.validating') : t('settings.apiKeys.save')}
							</button>
						</div>
					</div>
				{/if}
			</div>
		{/each}

		<h3 class="subsection-label subsection-label--optional">{t('settings.apiKeys.optionalSection')}</h3>
		{#each optionalServices as service}
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
							{removing[service] ? '...' : t('settings.apiKeys.remove')}
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
			<p class="muted">{t('common.loading')}</p>
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
					{#each ['openai', 'deepgram', 'anthropic'] as s}
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

	.btn-primary {
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

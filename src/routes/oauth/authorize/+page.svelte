<script lang="ts">
	import { t } from '$lib/i18n';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Default the card-authoring toggle on when the client asked for it, so the common case
	// (connect Claude, start making cards) is one click — but it stays visible and revocable.
	// The request-derived default is a $derived (not a $state initializer, which would only
	// capture the initial `data`); once the user touches the toggle their explicit choice wins.
	let allowWriteChoice = $state<boolean | null>(null);
	const allowWrite = $derived(allowWriteChoice ?? (data.invalid ? false : data.writeRequested));

	const clientName = $derived(data.invalid ? '' : data.client.name || $t('oauth.genericClient'));
</script>

<div class="oauth-consent">
	{#if data.invalid}
		<h1>{$t('oauth.invalidTitle')}</h1>
		<p class="muted">{$t('oauth.invalidDesc')}</p>
		<a class="btn-secondary" href="/settings">{$t('oauth.backToSettings')}</a>
	{:else}
		<h1>{$t('oauth.title')}</h1>
		<p class="lead">{$t('oauth.intro', { client: clientName })}</p>

		<ul class="scopes">
			<li>
				<span class="scope-icon" aria-hidden="true">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
				</span>
				<div>
					<strong>{$t('oauth.scopeReadTitle')}</strong>
					<span class="muted">{$t('oauth.scopeReadDesc')}</span>
				</div>
			</li>
			<li class="scope-toggle">
				<span class="scope-icon" aria-hidden="true">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
				</span>
				<div>
					<strong>{$t('oauth.scopeWriteTitle')}</strong>
					<span class="muted">{$t('oauth.scopeWriteDesc')}</span>
				</div>
				<label class="switch">
					<input
						type="checkbox"
						checked={allowWrite}
						onchange={(e) => (allowWriteChoice = e.currentTarget.checked)}
					/>
					<span class="slider"></span>
				</label>
			</li>
		</ul>

		<p class="fineprint">{$t('oauth.fineprint')}</p>

		<form method="POST" class="actions">
			<input type="hidden" name="client_id" value={data.params.clientId} />
			<input type="hidden" name="redirect_uri" value={data.params.redirectUri} />
			<input type="hidden" name="code_challenge" value={data.params.codeChallenge} />
			<input type="hidden" name="state" value={data.params.state} />
			<input type="hidden" name="resource" value={data.params.resource} />
			{#if allowWrite}
				<input type="hidden" name="allow_write" value="on" />
			{/if}
			<button class="btn-secondary" type="submit" formaction="?/deny">{$t('oauth.deny')}</button>
			<button class="btn-primary" type="submit" formaction="?/approve">{$t('oauth.approve')}</button>
		</form>
	{/if}
</div>

<!-- Buttons use the global .btn-primary/.btn-secondary recipes from app.css; only layout
     (sizing within this page) is added below. -->
<style>
	.oauth-consent {
		max-width: 460px;
		margin: 4rem auto;
		padding: 2rem 1rem;
	}
	h1 {
		font-size: 1.6rem;
		color: var(--text);
		margin-bottom: 0.5rem;
	}
	.lead {
		color: var(--text);
		margin-bottom: 1.5rem;
	}
	.muted {
		color: var(--text-muted);
	}
	.scopes {
		list-style: none;
		padding: 0;
		margin: 0 0 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.scopes li {
		display: flex;
		gap: 0.75rem;
		align-items: flex-start;
		padding: 0.9rem;
		border: 1px solid var(--border-muted);
		border-radius: var(--r-lg);
		background: var(--surface);
		box-shadow: var(--shadow-sm);
	}
	.scopes li.scope-toggle {
		align-items: center;
	}
	.scopes strong {
		display: block;
		color: var(--text);
		margin-bottom: 0.15rem;
	}
	.scopes div {
		flex: 1;
	}
	.scope-icon {
		display: inline-flex;
		color: var(--text-muted);
		margin-top: 0.1rem;
	}
	.fineprint {
		font-size: 0.85rem;
		color: var(--text-muted);
		margin-bottom: 1.5rem;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
	}
	.actions button,
	a.btn-secondary {
		min-height: 44px;
	}
	/* iOS-style toggle, matching the consent's "off is meaningful" intent. */
	.switch {
		position: relative;
		display: inline-block;
		width: 46px;
		height: 26px;
		flex-shrink: 0;
	}
	.switch input {
		opacity: 0;
		width: 0;
		height: 0;
	}
	.slider {
		position: absolute;
		inset: 0;
		background: var(--border-strong);
		border-radius: var(--r-pill);
		transition: background var(--t-med) var(--ease);
	}
	.slider::before {
		content: '';
		position: absolute;
		height: 20px;
		width: 20px;
		left: 3px;
		top: 3px;
		background: var(--text);
		border-radius: 50%;
		transition: transform var(--t-med) var(--ease);
	}
	.switch input:focus-visible + .slider {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}
	/* Checked = granting a permission → semantic success green, white thumb. */
	.switch input:checked + .slider {
		background: var(--success);
	}
	.switch input:checked + .slider::before {
		transform: translateX(20px);
	}
</style>

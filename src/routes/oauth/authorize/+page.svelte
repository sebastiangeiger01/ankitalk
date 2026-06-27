<script lang="ts">
	import { t } from '$lib/i18n';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Default the card-authoring toggle on when the client asked for it, so the common case
	// (connect Claude, start making cards) is one click — but it stays visible and revocable.
	let allowWrite = $state(data.invalid ? false : data.writeRequested);

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
				<span class="scope-icon" aria-hidden="true">📖</span>
				<div>
					<strong>{$t('oauth.scopeReadTitle')}</strong>
					<span class="muted">{$t('oauth.scopeReadDesc')}</span>
				</div>
			</li>
			<li class="scope-toggle">
				<span class="scope-icon" aria-hidden="true">✍️</span>
				<div>
					<strong>{$t('oauth.scopeWriteTitle')}</strong>
					<span class="muted">{$t('oauth.scopeWriteDesc')}</span>
				</div>
				<label class="switch">
					<input type="checkbox" bind:checked={allowWrite} />
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

<style>
	.oauth-consent {
		max-width: 460px;
		margin: 4rem auto;
		padding: 2rem;
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
		border: 1px solid var(--border, #e2e2e2);
		border-radius: 12px;
		background: var(--surface, #fafafa);
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
		font-size: 1.25rem;
		line-height: 1.4;
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
	.btn-primary,
	.btn-secondary {
		padding: 0.6rem 1.25rem;
		border-radius: 10px;
		font-size: 1rem;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
		text-decoration: none;
		display: inline-block;
	}
	.btn-primary {
		background: var(--accent, #4f46e5);
		color: #fff;
	}
	.btn-secondary {
		background: transparent;
		color: var(--text);
		border-color: var(--border, #d0d0d0);
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
		background: var(--border, #ccc);
		border-radius: 26px;
		transition: background 0.2s;
	}
	.slider::before {
		content: '';
		position: absolute;
		height: 20px;
		width: 20px;
		left: 3px;
		top: 3px;
		background: #fff;
		border-radius: 50%;
		transition: transform 0.2s;
	}
	.switch input:checked + .slider {
		background: var(--accent, #4f46e5);
	}
	.switch input:checked + .slider::before {
		transform: translateX(20px);
	}
</style>

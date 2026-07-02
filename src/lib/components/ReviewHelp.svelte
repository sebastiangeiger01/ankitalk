<script lang="ts">
	import { t } from '$lib/i18n';
	import { focusTrap } from '$lib/actions/focusTrap';

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	let { open, onclose }: Props = $props();
</script>

{#if open}
	<button class="help-backdrop" onclick={onclose} aria-label={$t('help.closeOverlay')}></button>
	<!-- Flex-centering wrapper: keeps the dialog centered while the global `pop` keyframes
	     animate its transform (a translate(-50%,-50%) self-center would fight them). -->
	<div class="help-wrap">
		<div
			class="help-overlay"
			role="dialog"
			aria-modal="true"
			aria-label={$t('help.title')}
			tabindex="-1"
			onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onclose(); } }}
			use:focusTrap
		>
			<div class="help-header">
				<span class="help-title">{$t('help.title')}</span>
				<button class="help-close" onclick={onclose} aria-label={$t('help.closeOverlay')}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
				</button>
			</div>

			<div class="help-section-title">{$t('help.keyboardTitle')}</div>
			<table class="help-table">
				<tbody>
					<tr><td><kbd>Space</kbd> / <kbd>Enter</kbd></td><td>{$t('help.keyAnswer')}</td></tr>
					<tr><td><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></td><td>{$t('help.keyRatings')}</td></tr>
					<tr><td><kbd>R</kbd></td><td>{$t('help.keyRepeat')}</td></tr>
					<tr><td><kbd>E</kbd></td><td>{$t('help.keyExplain')}</td></tr>
					<tr><td><kbd>H</kbd></td><td>{$t('help.keyHint')}</td></tr>
					<tr><td><kbd>Z</kbd></td><td>{$t('help.keyUndo')}</td></tr>
					<tr><td><kbd>Esc</kbd></td><td>{$t('help.keyStop')}</td></tr>
					<tr><td><kbd>?</kbd></td><td>{$t('help.keyHelp')}</td></tr>
				</tbody>
			</table>

			<div class="help-section-title">{$t('help.voiceTitle')}</div>
			<ul class="help-voice">
				<li><strong>{$t('help.answer')}</strong><span>{$t('help.answerDesc')}</span></li>
				<li><strong>{$t('help.ratings')}</strong><span>{$t('help.ratingsDesc')}</span></li>
				<li><strong>{$t('help.repeat')}</strong><span>{$t('help.repeatDesc')}</span></li>
				<li><strong>{$t('help.explain')}</strong><span>{$t('help.explainDesc')}</span></li>
				<li><strong>{$t('help.hint')}</strong><span>{$t('help.hintDesc')}</span></li>
				<li><strong>{$t('help.stop')}</strong><span>{$t('help.stopDesc')}</span></li>
			</ul>
		</div>
	</div>
{/if}

<style>
	.help-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.6);
		-webkit-backdrop-filter: blur(4px);
		backdrop-filter: blur(4px);
		border: 0;
		padding: 0;
		z-index: 200;
		animation: fade-in var(--t-fast) var(--ease);
	}

	.help-wrap {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem 1rem;
		z-index: 201;
		pointer-events: none;
	}

	.help-overlay {
		pointer-events: auto;
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		border-radius: var(--r-lg);
		box-shadow: var(--shadow-lg);
		padding: 1.25rem 1.5rem;
		/* No min-width: at 320px viewport a fixed width would push past the right edge.
		   Let the content (table + kbd labels) drive the width. */
		max-width: min(480px, calc(100vw - 2rem));
		max-height: 100%;
		overflow-y: auto;
		animation: pop var(--t-med) var(--ease);
	}

	.help-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	.help-title {
		font-size: 1rem;
		font-weight: 700;
		color: var(--text);
		letter-spacing: -0.015em;
	}

	.help-close {
		background: transparent;
		border: none;
		color: var(--text-subtle);
		cursor: pointer;
		border-radius: var(--r-sm);
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: 44px;
		min-height: 44px;
		margin: -0.75rem -0.75rem -0.75rem 0;
		transition: color var(--t-fast) var(--ease);
	}

	.help-close:hover {
		color: var(--text);
	}

	.help-section-title {
		font-size: 0.72rem;
		font-weight: 700;
		color: var(--text-subtle);
		text-transform: uppercase;
		letter-spacing: 0.07em;
		margin-bottom: 0.5rem;
	}

	.help-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
		margin-bottom: 1.4rem;
	}

	.help-table td {
		padding: 0.35rem 0;
		vertical-align: middle;
		color: var(--text-muted);
	}

	.help-table td:first-child {
		white-space: nowrap;
		padding-right: 1.25rem;
		color: var(--text);
	}

	.help-table tr + tr td {
		border-top: 1px solid var(--border-muted);
	}

	.help-voice {
		list-style: none;
		padding: 0;
		margin: 0;
		font-size: 0.875rem;
		color: var(--text-muted);
	}

	.help-voice li {
		display: flex;
		flex-wrap: wrap;
		column-gap: 0.6rem;
		padding: 0.35rem 0;
		border-top: 1px solid var(--border-muted);
	}

	.help-voice li:first-child {
		border-top: none;
	}

	.help-voice strong {
		color: var(--text);
		font-weight: 600;
	}

	kbd {
		font-size: 0.65rem;
		padding: 0.1rem 0.4rem;
		border-radius: 4px;
		background: rgba(255, 255, 255, 0.1);
		border: 1px solid rgba(255, 255, 255, 0.15);
		box-shadow: 0 1px 0 rgba(255, 255, 255, 0.08) inset;
		font-family: inherit;
		color: inherit;
	}
</style>

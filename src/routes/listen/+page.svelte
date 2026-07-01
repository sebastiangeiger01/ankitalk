<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { locale, t } from '$lib/i18n';
	import { focusTrap } from '$lib/actions/focusTrap';
	import Spinner from '$lib/components/Spinner.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { splitIntoSentences } from '$lib/listen/sentences';
	import { estimateCredits } from '$lib/listen/estimate';
	import { LISTEN_LANGUAGES } from '$lib/listen/languages';
	import { ELEVENLABS_TTS_MODELS } from '$lib/voice';
	import type { ListenDocumentSummary } from '$lib/listen/types';


	let text = $state('');
	let title = $state('');
	let modelId = $state('eleven_flash_v2_5');
	let voiceId = $state('');
	let language = $state('auto');
	let voices = $state<{ voiceId: string; name: string }[]>([]);
	let balanceRemaining = $state<number | null>(null);

	let documents = $state<ListenDocumentSummary[]>([]);
	let loadingHistory = $state(true);

	let submitting = $state(false);
	let errorMsg = $state('');
	let duplicateDocId = $state<string | null>(null);

	const charCount = $derived(text.length);
	const sentences = $derived(text.trim() ? splitIntoSentences(text) : []);
	const credits = $derived(estimateCredits(sentences.reduce((n, c) => n + c.length, 0), modelId));
	/* Compare estimated credits (chars × model multiplier — Flash/Turbo bill at 0.5×), not raw
	 * characters, or cheap models trip the warning with plenty of balance left. */
	const insufficient = $derived(balanceRemaining !== null && credits > balanceRemaining);

	onMount(async () => {
		try {
			const r = await fetch(`/api/settings/voice?locale=${encodeURIComponent($locale)}`);
			if (r.ok) {
				const d = (await r.json()) as { settings: { elevenlabs_tts_model: string; elevenlabs_voice_id: string } };
				modelId = d.settings.elevenlabs_tts_model;
				voiceId = d.settings.elevenlabs_voice_id;
			}
		} catch { /* keep defaults */ }

		try {
			const r = await fetch('/api/elevenlabs/voices');
			if (r.ok) voices = ((await r.json()) as { voices: { voiceId: string; name: string }[] }).voices;
		} catch { /* override picker stays empty */ }

		try {
			const r = await fetch('/api/elevenlabs/subscription');
			if (r.ok) balanceRemaining = ((await r.json()) as { charactersRemaining: number }).charactersRemaining;
		} catch { /* balance optional */ }

		await loadHistory();
	});

	async function loadHistory() {
		loadingHistory = true;
		try {
			const r = await fetch('/api/listen');
			if (r.ok) documents = ((await r.json()) as { documents: ListenDocumentSummary[] }).documents;
		} catch { /* ignore */ } finally {
			loadingHistory = false;
		}
	}

	async function handleFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		text = await file.text();
		if (!title.trim()) title = file.name.replace(/\.txt$/i, '');
		input.value = '';
	}

	async function submit(force = false) {
		if (!text.trim() || submitting) return;
		errorMsg = '';
		duplicateDocId = null;
		submitting = true;
		try {
			const res = await fetch('/api/listen', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text, title, voiceId, modelId, language: language === 'auto' ? null : language, force })
			});
			if (!res.ok) {
				errorMsg = $t('listen.error');
				return;
			}
			const data = (await res.json()) as { id?: string; duplicate?: boolean; existingDocumentId?: string };
			if (data.duplicate && data.existingDocumentId) {
				duplicateDocId = data.existingDocumentId;
				return;
			}
			if (!data.id) {
				errorMsg = $t('listen.error');
				return;
			}
			await goto(`/listen/${data.id}`);
		} catch {
			errorMsg = $t('listen.error');
		} finally {
			submitting = false;
		}
	}

	function expiryDays(expiresAt: string): number {
		const ms = new Date(expiresAt.replace(' ', 'T') + 'Z').getTime() - Date.now();
		return Math.max(0, Math.ceil(ms / 86_400_000));
	}

	let confirmDelete = $state<{ id: string; title: string } | null>(null);

	function askDelete(id: string, docTitle: string) {
		confirmDelete = { id, title: docTitle };
	}

	async function performDelete() {
		if (!confirmDelete) return;
		const { id } = confirmDelete;
		confirmDelete = null;
		const res = await fetch(`/api/listen/${id}`, { method: 'DELETE' });
		if (res.ok) await loadHistory();
	}
</script>

<div class="listen-page">
	<a href="/" class="back-link">&larr; {$t('appSettings.dashboard')}</a>
	<h1>{$t('listen.title')}</h1>
	<p class="subtitle">{$t('listen.subtitleV2')}</p>

	<section class="card">
		<label class="field-label" for="listen-text">{$t('listen.inputLabel')}</label>
		<textarea
			id="listen-text"
			class="text-input"
			rows="8"
			placeholder={$t('listen.pastePlaceholder')}
			bind:value={text}
			disabled={submitting}
		></textarea>

		<div class="row">
			<label class="btn-secondary upload-btn" class:disabled={submitting}>
				{$t('listen.uploadTxt')}
				<input type="file" accept=".txt,text/plain" onchange={handleFile} hidden disabled={submitting} />
			</label>
			<input
				class="title-input"
				type="text"
				placeholder={$t('listen.titlePlaceholder')}
				bind:value={title}
				disabled={submitting}
			/>
		</div>

		<div class="row override">
			<label class="override-field">
				<span>{$t('listen.model')}</span>
				<select bind:value={modelId} disabled={submitting}>
					{#each ELEVENLABS_TTS_MODELS as m}
						<option value={m.id}>{$t(`settings.elevenlabs.model.${m.id}`)}</option>
					{/each}
				</select>
			</label>
			{#if voices.length}
				<label class="override-field">
					<span>{$t('listen.voice')}</span>
					<select bind:value={voiceId} disabled={submitting}>
						{#each voices as v}
							<option value={v.voiceId}>{v.name}</option>
						{/each}
					</select>
				</label>
			{/if}
			<label class="override-field">
				<span>{$t('listen.language')}</span>
				<select bind:value={language} disabled={submitting}>
					<option value="auto">{$t('listen.languageAuto')}</option>
					{#each LISTEN_LANGUAGES as lang}
						<option value={lang.code}>{lang.name}</option>
					{/each}
				</select>
			</label>
		</div>
		<p class="override-hint">{$t('listen.languageHint')}</p>

		{#if charCount > 0}
			<div class="estimate" class:warn={insufficient}>
				<span>{$t('listen.characters', { count: charCount.toLocaleString() })}</span>
				<span>{$t('listen.sentenceCount', { count: sentences.length })}</span>
				<span class="credits">{$t('listen.creditsMax', { count: credits.toLocaleString() })}</span>
				{#if balanceRemaining !== null}
					<span class="balance">{$t('listen.balanceRemaining', { count: balanceRemaining.toLocaleString() })}</span>
				{/if}
			</div>
			<p class="hint">{$t('listen.payAsYouHear')}</p>
			{#if insufficient}
				<p class="warn-text">{$t('listen.insufficient')}</p>
			{/if}
		{/if}

		<button class="btn-primary generate-btn" onclick={() => submit(false)} disabled={!text.trim() || submitting}>
			{#if submitting}<Spinner size={14} />{/if}
			{submitting ? $t('listen.preparing') : $t('listen.openReader')}
		</button>

		{#if errorMsg}
			<p class="error-text">{errorMsg}</p>
		{/if}
	</section>

	{#if duplicateDocId}
		<!-- Bespoke modal shell (three actions don't fit the ConfirmDialog API) matching the
		     shared dialog look: blurred backdrop, surface, pop animation. "Open existing" is
		     the primary (free) action; "Create anyway" re-spends credits so it's demoted. -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div
			class="modal-backdrop"
			role="dialog"
			aria-modal="true"
			aria-labelledby="duplicate-title"
			tabindex="-1"
			onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); duplicateDocId = null; } }}
			use:focusTrap
		>
			<div class="modal">
				<h2 id="duplicate-title">{$t('listen.duplicateTitle')}</h2>
				<p>{$t('listen.duplicateBody')}</p>
				<div class="modal-actions">
					<button class="btn-ghost" onclick={() => (duplicateDocId = null)}>{$t('listen.cancel')}</button>
					<button class="btn-secondary" onclick={() => submit(true)}>{$t('listen.generateAnyway')}</button>
					<a class="btn-primary" href={`/listen/${duplicateDocId}`}>{$t('listen.openExisting')}</a>
				</div>
			</div>
		</div>
	{/if}

	<ConfirmDialog
		open={confirmDelete !== null}
		title={$t('listen.delete')}
		message={confirmDelete ? $t('listen.deleteConfirm', { title: confirmDelete.title }) : ''}
		confirmLabel={$t('common.delete')}
		danger
		onconfirm={performDelete}
		oncancel={() => (confirmDelete = null)}
	/>

	<section class="card">
		<h2 class="history-title">{$t('listen.historyTitle')}</h2>
		{#if loadingHistory}
			<!-- Card-shaped skeletons matching the history rows (global shimmer keyframes). -->
			<div class="doc-list" role="status" aria-label={$t('common.loading')}>
				{#each [0, 1, 2] as i (i)}
					<div class="doc-card skel-card" aria-hidden="true">
						<div class="skel skel-title-line"></div>
						<div class="skel skel-meta-line"></div>
					</div>
				{/each}
			</div>
		{:else if documents.length === 0}
			<div class="empty-state">
				<svg class="empty-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
					<path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
				</svg>
				<p class="empty-title">{$t('listen.empty')}</p>
				<p class="empty-hint">{$t('listen.emptyHint')}</p>
			</div>
		{:else}
			<ul class="doc-list">
				{#each documents as doc (doc.id)}
					<li class="doc-card">
						<a class="doc-link" href={`/listen/${doc.id}`}>
							<span class="doc-title">{doc.title}</span>
							<span class="doc-meta">
								<span>{$t('listen.cachedCount', { cached: doc.done_count, total: doc.segment_count })}</span>
								<span>{$t('listen.charsLabel', { count: doc.total_chars.toLocaleString() })}</span>
								<span class="expiry">{$t('listen.expiresIn', { days: expiryDays(doc.expires_at) })}</span>
							</span>
						</a>
						<button class="doc-action" aria-label={$t('listen.delete')} title={$t('listen.delete')} onclick={() => askDelete(doc.id, doc.title)}>
						<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
					</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<style>
	.listen-page { max-width: 640px; margin: 0 auto; }
	.back-link { color: var(--text-muted); text-decoration: none; font-size: 0.9rem; }
	.back-link:hover { color: var(--text); }
	h1 { margin: 1rem 0 0.25rem; font-size: 1.4rem; }
	.subtitle { color: var(--text-muted); font-size: 0.9rem; margin: 0 0 1.25rem; line-height: 1.45; }

	/* Surface/border/radius come from the global .card recipe; only layout lives here. */
	.card {
		padding: 1rem;
		margin-bottom: 1.25rem;
	}

	.field-label { display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.4rem; font-weight: 600; }

	.text-input {
		width: 100%;
		box-sizing: border-box;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
		color: var(--text);
		font-size: 0.92rem;
		line-height: 1.5;
		padding: 0.65rem 0.8rem;
		resize: vertical;
		transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
	}
	.text-input:focus { outline: none; border-color: var(--border-strong); box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.06); }

	.row { display: flex; gap: 0.6rem; margin-top: 0.6rem; flex-wrap: wrap; }
	.row.override { gap: 0.6rem; }

	/* On top of the global .btn-secondary recipe: it's a <label>, so :disabled never
	   matches — mirror the disabled look via the .disabled class. */
	.upload-btn { white-space: nowrap; font-size: 0.85rem; }
	.upload-btn.disabled { opacity: 0.45; cursor: not-allowed; }

	.title-input {
		flex: 1;
		min-width: 160px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
		color: var(--text);
		font-size: 0.88rem;
		padding: 0.5rem 0.7rem;
		transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
	}
	.title-input:focus { outline: none; border-color: var(--border-strong); box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.06); }

	.override-field { display: flex; flex-direction: column; gap: 0.25rem; flex: 1; min-width: 150px; }
	.override-field span { font-size: 0.76rem; color: var(--text-muted); }
	.override-field select {
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
		color: var(--text);
		font-size: 0.85rem;
		padding: 0.45rem 0.5rem;
	}

	.override-hint { font-size: 0.74rem; color: var(--text-subtle); margin: 0.4rem 0 0; line-height: 1.4; }

	.estimate {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		margin-top: 0.85rem;
		padding: 0.6rem 0.75rem;
		background: var(--surface-2);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-md);
		font-size: 0.82rem;
		color: var(--text-muted);
	}
	.estimate.warn { border-color: var(--danger-border); }
	.estimate .credits { color: var(--text); font-weight: 600; }
	.estimate .balance { color: var(--text-subtle); margin-left: auto; }
	.warn-text { color: var(--danger-soft); font-size: 0.82rem; margin: 0.4rem 0 0; }
	.hint { font-size: 0.78rem; color: var(--text-subtle); margin: 0.4rem 0 0; line-height: 1.4; }

	/* Layout-only additions to the global .btn-primary recipe. */
	.generate-btn {
		margin-top: 0.85rem;
		width: 100%;
		padding: 0.7rem;
	}

	.error-text { color: var(--danger-soft); font-size: 0.85rem; margin: 0.6rem 0 0; }

	.history-title { font-size: 1rem; color: var(--text-muted); margin: 0 0 0.75rem; }

	/* Empty history: a calm value-prop nudge toward the paste box above. */
	.empty-state {
		display: flex; flex-direction: column; align-items: center;
		text-align: center;
		gap: 0.35rem;
		padding: 1.5rem 1rem 1.25rem;
	}
	.empty-icon { color: var(--text-subtle); }
	.empty-title { margin: 0.5rem 0 0; font-size: 0.95rem; font-weight: 600; color: var(--text); }
	.empty-hint { margin: 0; font-size: 0.85rem; color: var(--text-muted); line-height: 1.5; max-width: 30rem; }

	.doc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
	.doc-card {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: var(--surface-2);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-md);
		overflow: hidden;
	}
	.doc-link { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.35rem; padding: 0.75rem 0.9rem; text-decoration: none; color: inherit; }
	.doc-link:hover { background: rgba(255, 255, 255, 0.05); }
	.doc-title { font-size: 0.95rem; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.doc-meta { display: flex; flex-wrap: wrap; gap: 0.4rem 0.7rem; font-size: 0.76rem; color: var(--text-muted); align-items: center; }
	.expiry { color: var(--text-subtle); }

	.doc-action {
		flex-shrink: 0;
		background: none;
		border: none;
		color: var(--text-subtle);
		cursor: pointer;
		padding: 0 0.9rem;
		align-self: stretch;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		touch-action: manipulation;
	}
	.doc-action:hover { color: var(--danger-soft); }

	/* History-list loading skeletons (global shimmer keyframes from app.css). */
	.skel-card { flex-direction: column; align-items: stretch; gap: 0.5rem; padding: 0.8rem 0.9rem; }
	.skel {
		border-radius: var(--r-sm);
		background: linear-gradient(90deg, var(--surface-elevated) 25%, var(--border) 50%, var(--surface-elevated) 75%);
		background-size: 200% 100%;
		animation: shimmer 1.6s linear infinite;
	}
	.skel-title-line { height: 0.95rem; width: 55%; }
	.skel-meta-line { height: 0.72rem; width: 82%; }

	.modal-backdrop {
		position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6);
		-webkit-backdrop-filter: blur(4px);
		backdrop-filter: blur(4px);
		display: flex; align-items: center; justify-content: center; padding: 1rem; z-index: 50;
		animation: fade-in var(--t-fast) var(--ease);
	}
	.modal {
		background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg);
		box-shadow: var(--shadow-lg);
		padding: 1.25rem; max-width: 420px; width: 100%;
		animation: pop var(--t-med) var(--ease);
	}
	.modal h2 { font-size: 1.05rem; margin: 0 0 0.5rem; }
	.modal p { color: var(--text-muted); font-size: 0.88rem; line-height: 1.45; margin: 0 0 1rem; }
	.modal-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: flex-end; }
	.modal-actions a { text-decoration: none; }
</style>

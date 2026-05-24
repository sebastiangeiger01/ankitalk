<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { locale, t } from '$lib/i18n';
	import Spinner from '$lib/components/Spinner.svelte';
	import { chunkText } from '$lib/listen/chunk';
	import { estimateCredits } from '$lib/listen/estimate';
	import { runGeneration, ListenKeyError } from '$lib/listen/client';
	import { LISTEN_LANGUAGES } from '$lib/listen/languages';
	import { ELEVENLABS_TTS_MODELS } from '$lib/voice';
	import type { ListenDocumentSummary } from '$lib/listen/types';

	let loc = $state('en');
	locale.subscribe((v) => { loc = v; });

	let text = $state('');
	let title = $state('');
	let modelId = $state('eleven_flash_v2_5');
	let voiceId = $state('');
	let language = $state('auto');
	let voices = $state<{ voiceId: string; name: string }[]>([]);
	let balanceRemaining = $state<number | null>(null);

	let documents = $state<ListenDocumentSummary[]>([]);
	let loadingHistory = $state(true);

	let generating = $state(false);
	let progressDone = $state(0);
	let progressTotal = $state(0);
	let errorMsg = $state('');
	let keyMissing = $state(false);
	let duplicateDocId = $state<string | null>(null);

	const charCount = $derived(text.length);
	const segments = $derived(text.trim() ? chunkText(text) : []);
	const credits = $derived(estimateCredits(segments.reduce((n, c) => n + c.length, 0), modelId));
	const insufficient = $derived(balanceRemaining !== null && charCount > balanceRemaining);

	onMount(async () => {
		try {
			const r = await fetch(`/api/settings/voice?locale=${encodeURIComponent(loc)}`);
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

	async function generate(force = false) {
		if (!text.trim() || generating) return;
		errorMsg = '';
		keyMissing = false;
		duplicateDocId = null;
		generating = true;
		progressDone = 0;
		progressTotal = segments.length;

		try {
			const res = await fetch('/api/listen', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text, title, voiceId, modelId, language: language === 'auto' ? null : language, force })
			});
			if (!res.ok) {
				errorMsg = t('listen.error');
				return;
			}
			const data = (await res.json()) as { id?: string; segmentCount?: number; duplicate?: boolean; existingDocumentId?: string };
			if (data.duplicate && data.existingDocumentId) {
				duplicateDocId = data.existingDocumentId;
				return;
			}
			if (!data.id) {
				errorMsg = t('listen.error');
				return;
			}
			progressTotal = data.segmentCount ?? segments.length;
			await runGeneration(data.id, (done, total) => {
				progressDone = done;
				progressTotal = total;
			});
			await goto(`/listen/${data.id}`);
		} catch (err) {
			if (err instanceof ListenKeyError) {
				keyMissing = true;
				errorMsg = t('listen.noKey');
			} else {
				errorMsg = t('listen.error');
			}
			await loadHistory();
		} finally {
			generating = false;
		}
	}

	function expiryDays(expiresAt: string): number {
		const ms = new Date(expiresAt.replace(' ', 'T') + 'Z').getTime() - Date.now();
		return Math.max(0, Math.ceil(ms / 86_400_000));
	}

	async function deleteDoc(id: string, docTitle: string) {
		if (!confirm(t('listen.deleteConfirm', { title: docTitle }))) return;
		const res = await fetch(`/api/listen/${id}`, { method: 'DELETE' });
		if (res.ok) await loadHistory();
	}
</script>

{#key loc}
<div class="listen-page">
	<a href="/" class="back-link">&larr; {t('appSettings.dashboard')}</a>
	<h1>{t('listen.title')}</h1>
	<p class="subtitle">{t('listen.subtitle')}</p>

	<section class="card">
		<label class="field-label" for="listen-text">{t('listen.inputLabel')}</label>
		<textarea
			id="listen-text"
			class="text-input"
			rows="8"
			placeholder={t('listen.pastePlaceholder')}
			bind:value={text}
			disabled={generating}
		></textarea>

		<div class="row">
			<label class="upload-btn" class:disabled={generating}>
				{t('listen.uploadTxt')}
				<input type="file" accept=".txt,text/plain" onchange={handleFile} hidden disabled={generating} />
			</label>
			<input
				class="title-input"
				type="text"
				placeholder={t('listen.titlePlaceholder')}
				bind:value={title}
				disabled={generating}
			/>
		</div>

		<div class="row override">
			<label class="override-field">
				<span>{t('listen.model')}</span>
				<select bind:value={modelId} disabled={generating}>
					{#each ELEVENLABS_TTS_MODELS as m}
						<option value={m.id}>{t(`settings.elevenlabs.model.${m.id}`)}</option>
					{/each}
				</select>
			</label>
			{#if voices.length}
				<label class="override-field">
					<span>{t('listen.voice')}</span>
					<select bind:value={voiceId} disabled={generating}>
						{#each voices as v}
							<option value={v.voiceId}>{v.name}</option>
						{/each}
					</select>
				</label>
			{/if}
			<label class="override-field">
				<span>{t('listen.language')}</span>
				<select bind:value={language} disabled={generating}>
					<option value="auto">{t('listen.languageAuto')}</option>
					{#each LISTEN_LANGUAGES as lang}
						<option value={lang.code}>{lang.name}</option>
					{/each}
				</select>
			</label>
		</div>
		<p class="override-hint">{t('listen.languageHint')}</p>

		{#if charCount > 0}
			<div class="estimate" class:warn={insufficient}>
				<span>{t('listen.characters', { count: charCount.toLocaleString() })}</span>
				<span>{t('listen.segments', { count: segments.length })}</span>
				<span class="credits">{t('listen.credits', { count: credits.toLocaleString() })}</span>
				{#if balanceRemaining !== null}
					<span class="balance">{t('listen.balanceRemaining', { count: balanceRemaining.toLocaleString() })}</span>
				{/if}
			</div>
			{#if insufficient}
				<p class="warn-text">{t('listen.insufficient')}</p>
			{/if}
		{/if}

		{#if generating}
			<div class="progress">
				<div class="progress-bar"><div class="progress-fill" style={`width:${progressTotal ? (progressDone / progressTotal) * 100 : 0}%`}></div></div>
				<span class="progress-text">{t('listen.progress', { done: progressDone, total: progressTotal })}</span>
			</div>
			<p class="hint">{t('listen.keepOpen')}</p>
		{:else}
			<button class="generate-btn" onclick={() => generate(false)} disabled={!text.trim()}>
				{t('listen.generate')}
			</button>
		{/if}

		{#if keyMissing}
			<p class="error-text">{t('listen.noKey')} <a href="/settings">{t('review.goToSettings')}</a></p>
		{:else if errorMsg}
			<p class="error-text">{errorMsg}</p>
		{/if}
	</section>

	{#if duplicateDocId}
		<div class="modal-backdrop">
			<div class="modal" role="dialog" aria-modal="true" tabindex="-1">
				<h2>{t('listen.duplicateTitle')}</h2>
				<p>{t('listen.duplicateBody')}</p>
				<div class="modal-actions">
					<a class="btn-secondary" href={`/listen/${duplicateDocId}`}>{t('listen.openExisting')}</a>
					<button class="btn-secondary" onclick={() => (duplicateDocId = null)}>{t('listen.cancel')}</button>
					<button class="btn-primary" onclick={() => generate(true)}>{t('listen.generateAnyway')}</button>
				</div>
			</div>
		</div>
	{/if}

	<section class="card">
		<h2 class="history-title">{t('listen.historyTitle')}</h2>
		{#if loadingHistory}
			<div class="center"><Spinner size={20} /></div>
		{:else if documents.length === 0}
			<p class="muted">{t('listen.empty')}</p>
		{:else}
			<ul class="doc-list">
				{#each documents as doc (doc.id)}
					<li class="doc-card">
						<a class="doc-link" href={`/listen/${doc.id}`}>
							<span class="doc-title">{doc.title}</span>
							<span class="doc-meta">
								<span class="status status--{doc.status}">{t(`listen.status.${doc.status}`)}</span>
								{#if doc.status !== 'complete'}
									<span>{doc.done_count}/{doc.segment_count}</span>
								{/if}
								<span>{t('listen.credits', { count: doc.estimated_credits.toLocaleString() })}</span>
								<span class="expiry">{t('listen.expiresIn', { days: expiryDays(doc.expires_at) })}</span>
							</span>
						</a>
						<button class="doc-action" aria-label={t('listen.delete')} onclick={() => deleteDoc(doc.id, doc.title)}>🗑</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
{/key}

<style>
	.listen-page { max-width: 640px; margin: 0 auto; }
	.back-link { color: #a8a8b8; text-decoration: none; font-size: 0.9rem; }
	.back-link:hover { color: #e0e0ff; }
	h1 { margin: 1rem 0 0.25rem; font-size: 1.4rem; }
	.subtitle { color: #8d8db0; font-size: 0.9rem; margin: 0 0 1.25rem; line-height: 1.45; }

	.card {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 12px;
		padding: 1rem;
		margin-bottom: 1.25rem;
	}

	.field-label { display: block; font-size: 0.85rem; color: #b0b0d0; margin-bottom: 0.4rem; font-weight: 600; }

	.text-input {
		width: 100%;
		box-sizing: border-box;
		background: #12121f;
		border: 1px solid #3a3a5e;
		border-radius: 8px;
		color: #e0e0ff;
		font-size: 0.92rem;
		line-height: 1.5;
		padding: 0.65rem 0.8rem;
		resize: vertical;
	}
	.text-input:focus { outline: none; border-color: #5a5a9e; }

	.row { display: flex; gap: 0.6rem; margin-top: 0.6rem; flex-wrap: wrap; }
	.row.override { gap: 0.6rem; }

	.upload-btn {
		display: inline-flex;
		align-items: center;
		padding: 0.5rem 0.9rem;
		background: #22223a;
		border: 1px solid #3a3a5e;
		color: #c0c0e0;
		border-radius: 7px;
		cursor: pointer;
		font-size: 0.85rem;
		font-weight: 600;
		white-space: nowrap;
		touch-action: manipulation;
	}
	.upload-btn:hover { border-color: #5a5a8e; }
	.upload-btn.disabled { opacity: 0.5; cursor: not-allowed; }

	.title-input {
		flex: 1;
		min-width: 160px;
		background: #12121f;
		border: 1px solid #3a3a5e;
		border-radius: 7px;
		color: #e0e0ff;
		font-size: 0.88rem;
		padding: 0.5rem 0.7rem;
	}
	.title-input:focus { outline: none; border-color: #5a5a9e; }

	.override-field { display: flex; flex-direction: column; gap: 0.25rem; flex: 1; min-width: 150px; }
	.override-field span { font-size: 0.76rem; color: #8d8db0; }
	.override-field select {
		background: #12121f;
		border: 1px solid #3a3a5e;
		border-radius: 7px;
		color: #e0e0ff;
		font-size: 0.85rem;
		padding: 0.45rem 0.5rem;
	}

	.override-hint { font-size: 0.74rem; color: #6a6a8a; margin: 0.4rem 0 0; line-height: 1.4; }

	.estimate {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1rem;
		margin-top: 0.85rem;
		padding: 0.6rem 0.75rem;
		background: #12121f;
		border: 1px solid #2e2e52;
		border-radius: 8px;
		font-size: 0.82rem;
		color: #a0a0c0;
	}
	.estimate.warn { border-color: #5a2a2a; }
	.estimate .credits { color: #8b8bea; font-weight: 600; }
	.estimate .balance { color: #6a6a8a; margin-left: auto; }
	.warn-text { color: #cc6666; font-size: 0.82rem; margin: 0.4rem 0 0; }

	.generate-btn {
		margin-top: 0.85rem;
		width: 100%;
		padding: 0.7rem;
		background: #3a3a6e;
		border: 1px solid #5a5a8e;
		color: #e0e0ff;
		border-radius: 8px;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
		touch-action: manipulation;
	}
	.generate-btn:hover:not(:disabled) { background: #4a4a8e; }
	.generate-btn:disabled { opacity: 0.45; cursor: not-allowed; }

	.progress { margin-top: 0.85rem; display: flex; align-items: center; gap: 0.6rem; }
	.progress-bar { flex: 1; height: 8px; border-radius: 99px; background: #2a2a4a; overflow: hidden; }
	.progress-fill { height: 100%; background: #6b6bc8; transition: width 0.2s; }
	.progress-text { font-size: 0.8rem; color: #a0a0c0; white-space: nowrap; }
	.hint { font-size: 0.78rem; color: #7a7a9a; margin: 0.4rem 0 0; }

	.error-text { color: #cc6666; font-size: 0.85rem; margin: 0.6rem 0 0; }
	.error-text a { color: #e07070; }

	.history-title { font-size: 1rem; color: #b0b0d0; margin: 0 0 0.75rem; }
	.center { display: flex; justify-content: center; padding: 1rem 0; color: #8080c0; }
	.muted { color: #5a5a7a; font-size: 0.88rem; }

	.doc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
	.doc-card {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: #22223a;
		border: 1px solid #2e2e52;
		border-radius: 10px;
		overflow: hidden;
	}
	.doc-link { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.35rem; padding: 0.75rem 0.9rem; text-decoration: none; color: inherit; }
	.doc-link:hover { background: #2a2a4e; }
	.doc-title { font-size: 0.95rem; font-weight: 600; color: #dadaff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.doc-meta { display: flex; flex-wrap: wrap; gap: 0.4rem 0.7rem; font-size: 0.76rem; color: #8d8db0; align-items: center; }
	.expiry { color: #6a6a8a; }

	.status { font-weight: 600; padding: 0.1rem 0.5rem; border-radius: 99px; font-size: 0.72rem; }
	.status--complete { background: #1a3a2a; color: #5aba84; }
	.status--generating, .status--pending { background: #2a2a4a; color: #9a9ac0; }
	.status--partial { background: #3a3320; color: #c8a85a; }
	.status--failed { background: #3a1a1a; color: #cc6666; }

	.doc-action {
		flex-shrink: 0;
		background: none;
		border: none;
		color: #7a7a9a;
		font-size: 1rem;
		cursor: pointer;
		padding: 0 0.9rem;
		align-self: stretch;
		touch-action: manipulation;
	}
	.doc-action:hover { color: #e07070; }

	.modal-backdrop {
		position: fixed; inset: 0; background: rgba(0,0,0,0.6);
		display: flex; align-items: center; justify-content: center; padding: 1rem; z-index: 50;
	}
	.modal { background: #1a1a2e; border: 1px solid #3a3a5e; border-radius: 12px; padding: 1.25rem; max-width: 420px; width: 100%; }
	.modal h2 { font-size: 1.05rem; margin: 0 0 0.5rem; }
	.modal p { color: #a0a0c0; font-size: 0.88rem; line-height: 1.45; margin: 0 0 1rem; }
	.modal-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: flex-end; }
	.btn-primary, .btn-secondary {
		padding: 0.5rem 0.9rem; border-radius: 7px; font-size: 0.85rem; font-weight: 600; cursor: pointer; text-decoration: none;
		touch-action: manipulation;
	}
	.btn-primary { background: #3a3a6e; border: 1px solid #5a5a8e; color: #e0e0ff; }
	.btn-secondary { background: #22223a; border: 1px solid #3a3a5e; color: #a8a8c8; }
</style>

<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { locale, t } from '$lib/i18n';
	import Spinner from '$lib/components/Spinner.svelte';
	import ListenPlayer from '$lib/components/ListenPlayer.svelte';
	import { runGeneration, ListenKeyError } from '$lib/listen/client';
	import type { ListenDocumentSummary, ListenSegmentInfo } from '$lib/listen/types';

	let loc = $state('en');
	locale.subscribe((v) => { loc = v; });

	const docId = $derived($page.params.id ?? '');

	let document = $state<ListenDocumentSummary | null>(null);
	let segments = $state<ListenSegmentInfo[]>([]);
	let loading = $state(true);
	let notFound = $state(false);
	let resuming = $state(false);
	let progressDone = $state(0);
	let progressTotal = $state(0);
	let errorMsg = $state('');
	let keyMissing = $state(false);

	const remaining = $derived(document ? document.segment_count - document.done_count : 0);

	onMount(load);

	async function load() {
		loading = true;
		notFound = false;
		try {
			const res = await fetch(`/api/listen/${docId}`);
			if (res.status === 404) {
				notFound = true;
				return;
			}
			if (!res.ok) return;
			const data = (await res.json()) as { document: ListenDocumentSummary; segments: ListenSegmentInfo[] };
			document = data.document;
			segments = data.segments;
		} catch { /* ignore */ } finally {
			loading = false;
		}
	}

	async function resume() {
		if (!document || resuming) return;
		errorMsg = '';
		keyMissing = false;
		resuming = true;
		progressDone = document.done_count;
		progressTotal = document.segment_count;
		try {
			await runGeneration(docId, (done, total) => {
				progressDone = done;
				progressTotal = total;
			});
		} catch (err) {
			if (err instanceof ListenKeyError) {
				keyMissing = true;
				errorMsg = t('listen.noKey');
			} else {
				errorMsg = t('listen.error');
			}
		} finally {
			resuming = false;
			await load();
		}
	}

	async function rename() {
		if (!document) return;
		const next = prompt(t('listen.rename'), document.title);
		if (!next || !next.trim()) return;
		const res = await fetch(`/api/listen/${docId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: next.trim() })
		});
		if (res.ok && document) document.title = next.trim();
	}

	async function remove() {
		if (!document) return;
		if (!confirm(t('listen.deleteConfirm', { title: document.title }))) return;
		const res = await fetch(`/api/listen/${docId}`, { method: 'DELETE' });
		if (res.ok) await goto('/listen');
	}
</script>

{#key loc}
<div class="doc-page">
	<a href="/listen" class="back-link">&larr; {t('listen.back')}</a>

	{#if loading}
		<div class="center"><Spinner size={24} /></div>
	{:else if notFound || !document}
		<p class="muted">{t('listen.notFound')}</p>
	{:else}
		<div class="doc-head">
			<h1>{document.title}</h1>
			<div class="head-actions">
				<button class="text-btn" onclick={rename}>{t('listen.rename')}</button>
				<button class="text-btn danger" onclick={remove}>{t('listen.delete')}</button>
			</div>
		</div>

		<div class="doc-sub">
			<span class="status status--{document.status}">{t(`listen.status.${document.status}`)}</span>
			<span>{t('listen.charsLabel', { count: document.total_chars.toLocaleString() })}</span>
			<span>{t('listen.credits', { count: document.estimated_credits.toLocaleString() })}</span>
		</div>

		{#if document.done_count > 0}
			<ListenPlayer documentId={docId} title={document.title} {segments} />
		{/if}

		{#if remaining > 0}
			{#if resuming}
				<div class="progress">
					<div class="progress-bar"><div class="progress-fill" style={`width:${progressTotal ? (progressDone / progressTotal) * 100 : 0}%`}></div></div>
					<span class="progress-text">{t('listen.progress', { done: progressDone, total: progressTotal })}</span>
				</div>
				<p class="hint">{t('listen.keepOpen')}</p>
			{:else}
				<button class="resume-btn" onclick={resume}>{t('listen.resume')} ({document.done_count}/{document.segment_count})</button>
			{/if}
		{/if}

		{#if keyMissing}
			<p class="error-text">{t('listen.noKey')} <a href="/settings">{t('review.goToSettings')}</a></p>
		{:else if errorMsg}
			<p class="error-text">{errorMsg}</p>
		{/if}
	{/if}
</div>
{/key}

<style>
	.doc-page { max-width: 640px; margin: 0 auto; }
	.back-link { color: #a8a8b8; text-decoration: none; font-size: 0.9rem; }
	.back-link:hover { color: #e0e0ff; }
	.center { display: flex; justify-content: center; padding: 2rem 0; color: #8080c0; }
	.muted { color: #5a5a7a; }

	.doc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin: 1rem 0 0.5rem; }
	.doc-head h1 { font-size: 1.3rem; margin: 0; min-width: 0; overflow-wrap: anywhere; }
	.head-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
	.text-btn { background: none; border: none; color: #8d8db0; font-size: 0.82rem; cursor: pointer; padding: 0.2rem 0.3rem; }
	.text-btn:hover { color: #e0e0ff; }
	.text-btn.danger:hover { color: #e07070; }

	.doc-sub { display: flex; flex-wrap: wrap; gap: 0.5rem 0.9rem; align-items: center; font-size: 0.8rem; color: #8d8db0; margin-bottom: 1rem; }
	.status { font-weight: 600; padding: 0.1rem 0.5rem; border-radius: 99px; font-size: 0.72rem; }
	.status--complete { background: #1a3a2a; color: #5aba84; }
	.status--generating, .status--pending { background: #2a2a4a; color: #9a9ac0; }
	.status--partial { background: #3a3320; color: #c8a85a; }
	.status--failed { background: #3a1a1a; color: #cc6666; }

	.resume-btn {
		margin-top: 1rem; width: 100%; padding: 0.7rem;
		background: #3a3a6e; border: 1px solid #5a5a8e; color: #e0e0ff;
		border-radius: 8px; font-size: 0.92rem; font-weight: 600; cursor: pointer; touch-action: manipulation;
	}
	.resume-btn:hover { background: #4a4a8e; }

	.progress { margin-top: 1rem; display: flex; align-items: center; gap: 0.6rem; }
	.progress-bar { flex: 1; height: 8px; border-radius: 99px; background: #2a2a4a; overflow: hidden; }
	.progress-fill { height: 100%; background: #6b6bc8; transition: width 0.2s; }
	.progress-text { font-size: 0.8rem; color: #a0a0c0; white-space: nowrap; }
	.hint { font-size: 0.78rem; color: #7a7a9a; margin: 0.4rem 0 0; }
	.error-text { color: #cc6666; font-size: 0.85rem; margin: 0.6rem 0 0; }
	.error-text a { color: #e07070; }
</style>

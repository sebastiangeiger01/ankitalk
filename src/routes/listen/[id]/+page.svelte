<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { locale, t } from '$lib/i18n';
	import Spinner from '$lib/components/Spinner.svelte';
	import { elevenLabsModelCreditMultiplier } from '$lib/voice';
	import type { ListenSentenceInfo, ListenSentencesResponse } from '$lib/listen/types';

	let loc = $state('en');
	locale.subscribe((v) => { loc = v; });

	const docId = $derived($page.params.id ?? '');

	let doc = $state<ListenSentencesResponse['document'] | null>(null);
	let sentences = $state<ListenSentenceInfo[]>([]);
	let cachedInitially = $state<Set<number>>(new Set());
	let listenedInSession = $state<Set<number>>(new Set());
	let loading = $state(true);
	let notFound = $state(false);
	let errorMsg = $state('');

	let audioEl = $state<HTMLAudioElement | null>(null);
	let streamSrc = $state('');
	let streamStartSeq = $state(0);
	let playing = $state(false);
	let curTime = $state(0); // seconds since stream start (relative to streamStartSeq)
	let editingSeq = $state<number | null>(null);
	let editingText = $state('');

	const totalChars = $derived(doc?.total_chars ?? 0);
	const sentenceCount = $derived(sentences.length);
	const multiplier = $derived(elevenLabsModelCreditMultiplier(doc?.tts_model ?? ''));

	/**
	 * Map current `audio.currentTime` (relative to the current stream's start sentence) to
	 * the sentence currently being spoken. Uses cumulative durations (actual for cached,
	 * estimated for uncached) so the highlight tracks even before metadata is refreshed.
	 */
	const activeSeq = $derived.by(() => {
		if (!sentences.length) return 0;
		let acc = 0;
		for (let i = streamStartSeq; i < sentences.length; i++) {
			const next = acc + sentences[i].duration_ms / 1000;
			if (curTime < next) return i;
			acc = next;
		}
		return sentences.length - 1;
	});

	const cachedNowCount = $derived(sentences.filter((s) => s.cached).length);

	// Live "credits spent" / "credits saved" since opening the doc. Stable after refresh —
	// uncached sentences I listened to count as spent, cached ones I listened to as saved.
	const spentEstimate = $derived(
		sentences
			.filter((s) => listenedInSession.has(s.seq) && !cachedInitially.has(s.seq))
			.reduce((sum, s) => sum + Math.ceil(s.char_count * multiplier), 0)
	);
	const savedEstimate = $derived(
		sentences
			.filter((s) => listenedInSession.has(s.seq) && cachedInitially.has(s.seq))
			.reduce((sum, s) => sum + Math.ceil(s.char_count * multiplier), 0)
	);

	onMount(async () => {
		await load();
		setupMediaSession();
		document.addEventListener('visibilitychange', onVisibility);
	});

	onDestroy(() => {
		if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
		teardownMediaSession();
	});

	async function load() {
		loading = true;
		notFound = false;
		try {
			const res = await fetch(`/api/listen/${docId}/sentences`);
			if (res.status === 404 || res.status === 409) {
				notFound = true;
				return;
			}
			if (!res.ok) return;
			const data = (await res.json()) as ListenSentencesResponse;
			doc = data.document;
			sentences = data.sentences;
			if (!cachedInitially.size) {
				cachedInitially = new Set(sentences.filter((s) => s.cached).map((s) => s.seq));
			}
		} catch { /* ignore */ } finally {
			loading = false;
		}
	}

	async function refreshSentences() {
		try {
			const res = await fetch(`/api/listen/${docId}/sentences`);
			if (!res.ok) return;
			const data = (await res.json()) as ListenSentencesResponse;
			doc = data.document;
			sentences = data.sentences;
		} catch { /* network blip ok */ }
	}

	function onVisibility() {
		if (!document.hidden) refreshSentences();
	}

	function setupMediaSession() {
		if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
		navigator.mediaSession.setActionHandler('play', () => togglePlay(true));
		navigator.mediaSession.setActionHandler('pause', () => togglePlay(false));
		navigator.mediaSession.setActionHandler('previoustrack', () => jumpTo(Math.max(0, activeSeq - 1)));
		navigator.mediaSession.setActionHandler('nexttrack', () =>
			jumpTo(Math.min(sentences.length - 1, activeSeq + 1))
		);
	}

	function teardownMediaSession() {
		if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
		try {
			navigator.mediaSession.setActionHandler('play', null);
			navigator.mediaSession.setActionHandler('pause', null);
			navigator.mediaSession.setActionHandler('previoustrack', null);
			navigator.mediaSession.setActionHandler('nexttrack', null);
		} catch { /* no-op */ }
	}

	function updateMediaMetadata() {
		if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !doc) return;
		try {
			navigator.mediaSession.metadata = new MediaMetadata({
				title: doc.title || t('listen.title'),
				artist: 'AnkiTalk',
				album: sentences[activeSeq]?.text.slice(0, 60) ?? ''
			});
			navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
		} catch { /* no-op */ }
	}

	async function startStream(fromSeq: number) {
		streamStartSeq = fromSeq;
		curTime = 0;
		streamSrc = `/api/listen/${docId}/stream?from=${fromSeq}`;
		await tick();
		if (!audioEl) return;
		audioEl.load();
		try {
			await audioEl.play();
			playing = true;
			updateMediaMetadata();
		} catch {
			playing = false;
		}
	}

	async function togglePlay(force?: boolean) {
		if (!sentences.length) return;
		const wantPlay = force ?? !playing;
		if (wantPlay) {
			if (!streamSrc) {
				await startStream(streamStartSeq);
				return;
			}
			try {
				await audioEl?.play();
				playing = true;
				updateMediaMetadata();
			} catch {
				playing = false;
			}
		} else {
			audioEl?.pause();
			playing = false;
			updateMediaMetadata();
			refreshSentences();
		}
	}

	async function jumpTo(seq: number) {
		if (!sentences.length) return;
		const clamped = Math.max(0, Math.min(sentences.length - 1, seq));
		await startStream(clamped);
	}

	function onTimeUpdate() {
		if (!audioEl) return;
		curTime = audioEl.currentTime;
		if (!listenedInSession.has(activeSeq)) {
			const next = new Set(listenedInSession);
			next.add(activeSeq);
			listenedInSession = next;
		}
		updateMediaMetadata();
	}

	function onEnded() {
		playing = false;
		updateMediaMetadata();
		refreshSentences();
	}

	function onAudioError() {
		errorMsg = t('listen.streamError');
		playing = false;
	}

	function startEdit(seq: number) {
		editingSeq = seq;
		editingText = sentences[seq]?.text ?? '';
	}

	function cancelEdit() {
		editingSeq = null;
		editingText = '';
	}

	async function saveEdit(seq: number) {
		const next = editingText.trim();
		if (!next || next === sentences[seq]?.text) {
			cancelEdit();
			return;
		}
		try {
			const res = await fetch(`/api/listen/${docId}/sentences/${seq}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: next })
			});
			if (!res.ok) {
				errorMsg = t('listen.editError');
				return;
			}
			const data = (await res.json()) as { text: string; char_count: number; sentence_hash: string };
			sentences = sentences.map((s) =>
				s.seq === seq
					? { ...s, text: data.text, char_count: data.char_count, sentence_hash: data.sentence_hash, cached: false }
					: s
			);
			const init = new Set(cachedInitially);
			init.delete(seq);
			cachedInitially = init;
			cancelEdit();
		} catch {
			errorMsg = t('listen.editError');
		}
	}

	async function rename() {
		if (!doc) return;
		const next = prompt(t('listen.rename'), doc.title);
		if (!next || !next.trim()) return;
		const res = await fetch(`/api/listen/${docId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: next.trim() })
		});
		if (res.ok && doc) doc = { ...doc, title: next.trim() };
	}

	async function remove() {
		if (!doc) return;
		if (!confirm(t('listen.deleteConfirm', { title: doc.title }))) return;
		const res = await fetch(`/api/listen/${docId}`, { method: 'DELETE' });
		if (res.ok) await goto('/listen');
	}

	function expiryDays(expiresAt: string): number {
		const ms = new Date(expiresAt.replace(' ', 'T') + 'Z').getTime() - Date.now();
		return Math.max(0, Math.ceil(ms / 86_400_000));
	}
</script>

{#key loc}
<div class="reader">
	<a href="/listen" class="back-link">&larr; {t('listen.back')}</a>

	{#if loading}
		<div class="center"><Spinner size={24} /></div>
	{:else if notFound || !doc}
		<p class="muted">{t('listen.notFound')}</p>
	{:else}
		<div class="doc-head">
			<h1>{doc.title}</h1>
			<div class="head-actions">
				<button class="text-btn" onclick={rename}>{t('listen.rename')}</button>
				<button class="text-btn danger" onclick={remove}>{t('listen.delete')}</button>
			</div>
		</div>

		<div class="doc-sub">
			<span>{t('listen.cachedCount', { cached: cachedNowCount, total: sentenceCount })}</span>
			<span>{t('listen.charsLabel', { count: totalChars.toLocaleString() })}</span>
			<span class="expiry">{t('listen.expiresIn', { days: expiryDays(doc.expires_at) })}</span>
		</div>

		<p class="legend">
			<span class="dot dot--cached"></span> {t('listen.legendCached')}
			<span class="dot dot--listened"></span> {t('listen.legendListened')}
			<span class="dot dot--default"></span> {t('listen.legendDefault')}
		</p>

		<div class="text-body">
			{#each sentences as s (s.seq)}
				{#if editingSeq === s.seq}
					<div class="sentence-edit">
						<textarea class="edit-input" bind:value={editingText} rows="3"></textarea>
						<div class="edit-actions">
							<button class="edit-btn" onclick={() => saveEdit(s.seq)}>{t('listen.saveEdit')}</button>
							<button class="edit-btn ghost" onclick={cancelEdit}>{t('listen.cancel')}</button>
						</div>
					</div>
				{:else}
					<span class="sentence-wrap"><button
						class="sentence"
						class:cached={s.cached}
						class:listened={listenedInSession.has(s.seq) && !s.cached}
						class:active={s.seq === activeSeq && playing}
						onclick={() => jumpTo(s.seq)}
						title={t('listen.tapToJump')}
					>{s.text}</button><button
						class="edit-pencil"
						aria-label={t('listen.edit')}
						onclick={() => startEdit(s.seq)}
					>✎</button> </span>
				{/if}
			{/each}
		</div>

		{#if errorMsg}
			<p class="error-text">{errorMsg}</p>
		{/if}

		<div class="player-bar">
			<button class="skip-btn" onclick={() => jumpTo(activeSeq - 1)} aria-label={t('listen.previous')} disabled={activeSeq <= 0}>⏮</button>
			<button class="play-btn" onclick={() => togglePlay()} aria-label={playing ? t('listen.pause') : t('listen.play')}>
				{#if playing}❚❚{:else}▶{/if}
			</button>
			<button class="skip-btn" onclick={() => jumpTo(activeSeq + 1)} aria-label={t('listen.next')} disabled={activeSeq >= sentences.length - 1}>⏭</button>
			<div class="progress">
				<div class="progress-line">{activeSeq + 1} / {sentenceCount}</div>
				<div class="bar">
					<div class="fill" style={`width:${((activeSeq + 1) / sentenceCount) * 100}%`}></div>
				</div>
				<div class="credit-line">
					<span class="spent">−{spentEstimate.toLocaleString()} {t('listen.creditsShort')}</span>
					<span class="saved">{t('listen.savedLabel', { count: savedEstimate.toLocaleString() })}</span>
				</div>
			</div>
		</div>

		<audio
			bind:this={audioEl}
			src={streamSrc}
			ontimeupdate={onTimeUpdate}
			onended={onEnded}
			onerror={onAudioError}
			preload="none"
		></audio>
	{/if}
</div>
{/key}

<style>
	.reader { max-width: 720px; margin: 0 auto; padding-bottom: 7rem; }
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

	.doc-sub { display: flex; flex-wrap: wrap; gap: 0.5rem 0.9rem; align-items: center; font-size: 0.8rem; color: #8d8db0; margin-bottom: 0.6rem; }
	.expiry { color: #6a6a8a; }

	.legend {
		display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 1rem;
		font-size: 0.72rem; color: #7a7a9a; margin: 0 0 1rem;
	}
	.dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; display: inline-block; margin-right: 0.3rem; vertical-align: middle; }
	.dot--cached { background: #2a7a4c; }
	.dot--listened { background: #4a9870; }
	.dot--default { background: #3a3a5e; }

	.text-body {
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 12px;
		padding: 1rem 1.05rem;
		font-size: 1rem;
		line-height: 1.8;
		color: #d6d6f2;
	}

	.sentence-wrap { display: inline; }

	.sentence {
		display: inline;
		background: none;
		border: none;
		padding: 0.1rem 0.1rem;
		margin: 0;
		font: inherit;
		color: inherit;
		text-align: left;
		cursor: pointer;
		border-radius: 4px;
		border-bottom: 2px solid transparent;
		transition: background 0.15s, border-color 0.15s;
		-webkit-tap-highlight-color: transparent;
	}
	.sentence:hover { background: rgba(90, 90, 142, 0.18); }

	.sentence.listened { border-bottom-color: rgba(90, 186, 132, 0.55); }
	.sentence.cached { border-bottom-color: #2a7a4c; }
	.sentence.active {
		background: rgba(200, 168, 90, 0.22);
		border-bottom-color: #c8a85a;
		animation: pulse 1.4s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { background-color: rgba(200, 168, 90, 0.22); }
		50% { background-color: rgba(200, 168, 90, 0.38); }
	}

	.edit-pencil {
		background: none; border: none; color: #5a5a7a; font-size: 0.78rem;
		margin-left: 0.05rem; padding: 0 0.15rem; cursor: pointer; opacity: 0.4;
	}
	.edit-pencil:hover { opacity: 1; color: #b0b0d0; }

	.sentence-edit {
		display: block;
		background: #12121f;
		border: 1px solid #5a5a8e;
		border-radius: 8px;
		padding: 0.5rem;
		margin: 0.4rem 0;
	}
	.edit-input {
		width: 100%; box-sizing: border-box;
		background: #1a1a2e; border: 1px solid #3a3a5e; border-radius: 6px;
		color: #e0e0ff; font: inherit; padding: 0.4rem 0.55rem; resize: vertical;
	}
	.edit-actions { display: flex; gap: 0.4rem; margin-top: 0.4rem; }
	.edit-btn {
		padding: 0.35rem 0.7rem; border-radius: 6px; border: 1px solid #5a5a8e;
		background: #3a3a6e; color: #e0e0ff; font-size: 0.82rem; cursor: pointer; font-weight: 600;
	}
	.edit-btn.ghost { background: #22223a; color: #a8a8c8; }

	.error-text { color: #cc6666; font-size: 0.85rem; margin: 0.6rem 0 0; }

	.player-bar {
		position: fixed; left: 0; right: 0; bottom: 0;
		background: #16162a;
		border-top: 1px solid #2a2a4a;
		padding: 0.7rem 0.9rem calc(0.7rem + env(safe-area-inset-bottom));
		display: flex; align-items: center; gap: 0.6rem;
		z-index: 20;
	}

	.play-btn {
		flex-shrink: 0;
		width: 3rem; height: 3rem; border-radius: 50%;
		border: 1px solid #5a5a8e; background: #3a3a6e; color: #e0e0ff;
		font-size: 1rem; cursor: pointer; display: flex; align-items: center; justify-content: center;
		touch-action: manipulation;
	}
	.skip-btn {
		flex-shrink: 0;
		width: 2.2rem; height: 2.2rem; border-radius: 50%;
		border: 1px solid #3a3a5e; background: #22223a; color: #c0c0e0;
		font-size: 0.85rem; cursor: pointer; display: flex; align-items: center; justify-content: center;
		touch-action: manipulation;
	}
	.skip-btn:disabled { opacity: 0.35; cursor: not-allowed; }

	.progress { flex: 1; display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
	.progress-line { font-size: 0.78rem; color: #a0a0c0; }
	.bar { height: 5px; background: #2a2a4a; border-radius: 99px; overflow: hidden; }
	.fill { height: 100%; background: #6b6bc8; transition: width 0.15s linear; }
	.credit-line { display: flex; gap: 0.7rem; font-size: 0.7rem; color: #7a7a9a; }
	.spent { color: #c8a85a; }
	.saved { color: #5aba84; }
</style>

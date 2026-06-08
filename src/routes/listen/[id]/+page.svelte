<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { t } from '$lib/i18n';
	import Spinner from '$lib/components/Spinner.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import PromptDialog from '$lib/components/PromptDialog.svelte';
	import { elevenLabsModelCreditMultiplier } from '$lib/voice';
	import type { ListenSentenceInfo, ListenSentencesResponse } from '$lib/listen/types';


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
	let pollHandle: ReturnType<typeof setInterval> | null = null;

	// Per-document persisted progress: where you last paused (lastSeq) and the farthest you've
	// ever reached (maxSeq, used for the "farthest ahead" marker the user asked for). Restored
	// on mount so reopening a long document drops you back where you were instead of at the top.
	const PROGRESS_KEY = $derived(`listen-progress:${docId}`);
	let maxSeq = $state(0);

	// PLAYBACK rate: client-side audio.playbackRate. Instant, free, applies to already-cached
	// audio. No re-billing.
	const RATE_KEY = 'listen-playback-rate';
	let playbackRate = $state(1);

	// GENERATION speed: ElevenLabs voice_settings.speed (range 0.7–1.2). Affects voice naturalness
	// at synthesis time, baked into the audio file. Changing it invalidates the cache (because
	// the sentence hash now includes speed), so a new value re-generates affected sentences and
	// re-bills credits. Surfaced alongside playback rate so users can A/B them.
	const GEN_KEY = 'listen-gen-speed';
	let genSpeed = $state(1);

	let showSpeed = $state(false);

	// "Jump to current sentence" and "scroll to top" affordances. Both visibilities are derived
	// from scroll position so the floating pills appear only when actually useful.
	let activeSentenceEl = $state<HTMLElement | null>(null);
	let scrolledAway = $state(false);
	let activeOffScreen = $state(false);
	// Throttle the auto-scroll so it doesn't fight the user mid-flick.
	let lastAutoScrollSeq = -1;

	// Track the DOM node of the currently-active sentence so the floating "jump to current"
	// pill can scroll to it. Re-resolved whenever activeSeq or the sentence list changes;
	// a querySelector pass is cheaper than a per-sentence bind:this for long documents.
	$effect(() => {
		void activeSeq;
		void sentences;
		activeSentenceEl =
			document.querySelector<HTMLElement>(`.sentence-wrap[data-seq="${activeSeq}"]`) ?? null;
		// Recompute off-screen flag after a layout change.
		onScroll();
	});

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

	// Live "credits spent" / "credits saved" since opening the doc.
	// `spent` tracks what the *server actually generated* this session (sentences that
	// flipped from uncached at load time to cached now). This matches actual ElevenLabs
	// billing — including any buffer-ahead the browser triggers. The previous version
	// only counted what the user audibly passed, which silently under-reported by the
	// pre-buffer amount.
	// `saved` tracks cached sentences the user actually consumed (heard), so it stays
	// gated on `listenedInSession`.
	const spentEstimate = $derived(
		sentences
			.filter((s) => s.cached && !cachedInitially.has(s.seq))
			.reduce((sum, s) => sum + Math.ceil(s.char_count * multiplier), 0)
	);
	const savedEstimate = $derived(
		sentences
			.filter((s) => listenedInSession.has(s.seq) && cachedInitially.has(s.seq))
			.reduce((sum, s) => sum + Math.ceil(s.char_count * multiplier), 0)
	);

	onMount(async () => {
		// Restore both speed prefs (per-user, persisted across docs) before mounting audio.
		const savedRate = parseFloat(localStorage.getItem(RATE_KEY) ?? '1');
		if (savedRate >= 0.5 && savedRate <= 3) playbackRate = savedRate;
		const savedGen = parseFloat(localStorage.getItem(GEN_KEY) ?? '1');
		if (savedGen >= 0.7 && savedGen <= 1.2) genSpeed = savedGen;
		await load();
		setupMediaSession();
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('scroll', onScroll, { passive: true });
		await restoreScrollToLastHeard();
	});

	onDestroy(() => {
		if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
		if (typeof window !== 'undefined') window.removeEventListener('scroll', onScroll);
		stopPolling();
		teardownMediaSession();
		// Final flush of progress so a quick close after pause still persists.
		persistProgress();
	});

	/**
	 * On open, scroll the sentence the user was last on into view. If there's no saved progress
	 * (first visit) we stay at the top. We don't auto-play — the user opted into reading,
	 * not into listening.
	 */
	async function restoreScrollToLastHeard() {
		try {
			const raw = localStorage.getItem(PROGRESS_KEY);
			if (!raw) return;
			const data = JSON.parse(raw) as { lastSeq?: number; maxSeq?: number };
			if (typeof data.maxSeq === 'number') maxSeq = data.maxSeq;
			if (typeof data.lastSeq === 'number' && data.lastSeq > 0 && sentences[data.lastSeq]) {
				// Also seed streamStartSeq so pressing play resumes from where the user left off
				// (activeSeq is $derived from streamStartSeq + curTime, so this updates the
				// active highlight too — the seek bar and "X / total" land on the right spot).
				streamStartSeq = data.lastSeq;
				await tick();
				document
					.querySelector<HTMLElement>(`[data-seq="${data.lastSeq}"]`)
					?.scrollIntoView({ block: 'center', behavior: 'auto' });
				lastAutoScrollSeq = data.lastSeq;
			}
		} catch {
			/* corrupted localStorage entry — ignore */
		}
	}

	/** Save current position + farthest-seen seq. Debounced via the polling/onEnded cadence. */
	function persistProgress() {
		try {
			localStorage.setItem(
				PROGRESS_KEY,
				JSON.stringify({ lastSeq: activeSeq, maxSeq, savedAt: Date.now() })
			);
		} catch {
			/* localStorage full / Safari private mode — silent */
		}
	}

	function onScroll() {
		scrolledAway = window.scrollY > 400;
		if (!activeSentenceEl) {
			activeOffScreen = false;
			return;
		}
		const r = activeSentenceEl.getBoundingClientRect();
		// Off-screen if outside the visible vertical band, accounting for the bottom player.
		activeOffScreen = r.bottom < 80 || r.top > window.innerHeight - 140;
	}

	function scrollToTop() {
		window.scrollTo({ top: 0, behavior: 'smooth' });
	}

	function scrollToActive() {
		activeSentenceEl?.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}

	/**
	 * Refresh sentence metadata (cache flags + actual durations) while playing. Browsers
	 * buffer the audio stream aggressively, so a few seconds in many sentences ahead of
	 * playback are already generated and cached. Polling lets the highlight catch up to
	 * real durations once they're known.
	 */
	function startPolling() {
		if (pollHandle) return;
		pollHandle = setInterval(() => {
			if (!document.hidden) refreshSentences();
			persistProgress();
		}, 3000);
	}

	function stopPolling() {
		if (pollHandle) {
			clearInterval(pollHandle);
			pollHandle = null;
		}
	}

	function sentencesUrl(): string {
		// Server keys cache by speed, so the client must ask for the right speed lane to see
		// the right "cached" flags. At default 1.0× this is the fast canonical path.
		return `/api/listen/${docId}/sentences?speed=${genSpeed}`;
	}

	async function load() {
		loading = true;
		notFound = false;
		try {
			const res = await fetch(sentencesUrl());
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
			const res = await fetch(sentencesUrl());
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
				title: doc.title || $t('listen.title'),
				artist: 'AnkiTalk',
				album: sentences[activeSeq]?.text.slice(0, 60) ?? ''
			});
			navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
		} catch { /* no-op */ }
	}

	async function startStream(fromSeq: number) {
		streamStartSeq = fromSeq;
		curTime = 0;
		// Pass the generation speed so the server picks the right cache lane and (on misses)
		// synthesizes at that tempo.
		streamSrc = `/api/listen/${docId}/stream?from=${fromSeq}&speed=${genSpeed}`;
		await tick();
		if (!audioEl) return;
		audioEl.load();
		try {
			await audioEl.play();
			playing = true;
			startPolling();
			updateMediaMetadata();
		} catch {
			playing = false;
		}
	}

	/**
	 * Hard-close the server stream (set src=''  + load) so the worker loop doesn't keep
	 * generating sentences past the user's pause point. Without this, browsers buffer
	 * 30–60s ahead of playback and the server happily burns credits filling that buffer.
	 */
	function closeStream() {
		streamSrc = '';
		if (audioEl) {
			audioEl.pause();
			audioEl.removeAttribute('src');
			try {
				audioEl.load();
			} catch {
				/* no-op */
			}
		}
	}

	async function togglePlay(force?: boolean) {
		if (!sentences.length) return;
		const wantPlay = force ?? !playing;
		if (wantPlay) {
			// After a pause the stream was closed; reopen from where we left off.
			if (!streamSrc) {
				await startStream(activeSeq);
				return;
			}
			try {
				await audioEl?.play();
				playing = true;
				startPolling();
				updateMediaMetadata();
			} catch {
				playing = false;
			}
		} else {
			playing = false;
			stopPolling();
			closeStream();
			updateMediaMetadata();
			persistProgress();
			refreshSentences();
		}
	}

	async function jumpTo(seq: number) {
		if (!sentences.length) return;
		const clamped = Math.max(0, Math.min(sentences.length - 1, seq));
		await startStream(clamped);
	}

	/** Total document duration in ms (sums actual when cached, estimated otherwise). */
	const totalDurationMs = $derived(sentences.reduce((sum, s) => sum + s.duration_ms, 0));

	/** Cumulative duration up to (not including) the active sentence, plus the in-sentence offset. */
	const elapsedMs = $derived.by(() => {
		if (!sentences.length) return 0;
		let acc = 0;
		for (let i = 0; i < activeSeq && i < sentences.length; i++) acc += sentences[i].duration_ms;
		// curTime is relative to streamStartSeq; subtract everything before that out of the offset.
		let streamOffset = 0;
		for (let i = streamStartSeq; i < activeSeq && i < sentences.length; i++) streamOffset += sentences[i].duration_ms;
		return acc + Math.max(0, curTime * 1000 - streamOffset);
	});

	function formatTime(ms: number): string {
		const total = Math.max(0, Math.round(ms / 1000));
		const m = Math.floor(total / 60);
		const s = total % 60;
		return `${m}:${String(s).padStart(2, '0')}`;
	}

	/** Map a click on the seek bar to the nearest sentence by cumulative duration. */
	function onSeekClick(e: MouseEvent) {
		if (!sentences.length) return;
		const target = e.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();
		const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
		const targetMs = pct * totalDurationMs;
		let acc = 0;
		for (let i = 0; i < sentences.length; i++) {
			acc += sentences[i].duration_ms;
			if (targetMs <= acc) {
				void jumpTo(i);
				return;
			}
		}
		void jumpTo(sentences.length - 1);
	}

	function onSeekKey(e: KeyboardEvent) {
		if (!sentences.length) return;
		switch (e.key) {
			case 'ArrowLeft':
			case 'ArrowDown':
				e.preventDefault();
				void jumpTo(activeSeq - 1);
				break;
			case 'ArrowRight':
			case 'ArrowUp':
				e.preventDefault();
				void jumpTo(activeSeq + 1);
				break;
			case 'Home':
				e.preventDefault();
				void jumpTo(0);
				break;
			case 'End':
				e.preventDefault();
				void jumpTo(sentences.length - 1);
				break;
		}
	}

	function onTimeUpdate() {
		if (!audioEl) return;
		curTime = audioEl.currentTime;
		if (!listenedInSession.has(activeSeq)) {
			const next = new Set(listenedInSession);
			next.add(activeSeq);
			listenedInSession = next;
		}
		if (activeSeq > maxSeq) maxSeq = activeSeq;
		// Auto-scroll the active sentence into view as playback advances — but only when it
		// changes (not on every timeupdate tick) so we don't fight a user who deliberately
		// scrolled elsewhere. If the user IS reading elsewhere they'll see the "current
		// sentence" pill and can opt back in.
		if (activeSeq !== lastAutoScrollSeq && !activeOffScreen) {
			lastAutoScrollSeq = activeSeq;
			activeSentenceEl?.scrollIntoView({ block: 'center', behavior: 'smooth' });
		}
		updateMediaMetadata();
	}

	function onRateChange(value: number) {
		playbackRate = value;
		if (audioEl) audioEl.playbackRate = value;
		try {
			localStorage.setItem(RATE_KEY, String(value));
		} catch {
			/* private mode — silent */
		}
	}

	/**
	 * Switch generation speed. Unlike playbackRate (which is purely client-side), this changes
	 * the cache key the server uses — so the current in-flight stream is no longer the right
	 * tempo. Close it, refresh the sentence list at the new speed (so "cached" flags reflect
	 * the new lane), and let the user press play again to start a new stream that synthesizes
	 * (and bills) anything not yet cached at this speed.
	 */
	async function onGenSpeedChange(value: number) {
		if (value === genSpeed) return;
		genSpeed = value;
		try {
			localStorage.setItem(GEN_KEY, String(value));
		} catch {
			/* private mode — silent */
		}
		const wasPlaying = playing;
		if (wasPlaying) togglePlay(false);
		// Pull fresh cached state for the new speed so the UI accurately reflects what will
		// re-synthesize vs hit cache the next time the user presses play.
		await refreshSentences();
		// Recompute cachedInitially against the new lane — credit-spent accounting resets so
		// "what re-generated since I changed speed" is the meaningful number.
		cachedInitially = new Set(sentences.filter((s) => s.cached).map((s) => s.seq));
	}

	/** Apply the saved rate every time the audio element reattaches (after pause/jump). */
	function onAudioLoaded() {
		if (audioEl) audioEl.playbackRate = playbackRate;
	}

	function onEnded() {
		persistProgress();
		playing = false;
		stopPolling();
		updateMediaMetadata();
		refreshSentences();
	}

	function onAudioError() {
		errorMsg = $t('listen.streamError');
		playing = false;
		stopPolling();
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
				errorMsg = $t('listen.editError');
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
			errorMsg = $t('listen.editError');
		}
	}

	let renameOpen = $state(false);
	let renameError = $state('');
	let confirmRemoveOpen = $state(false);

	function rename() {
		if (!doc) return;
		renameError = '';
		renameOpen = true;
	}

	async function performRename(next: string) {
		if (!doc) return;
		const trimmed = next.trim();
		if (!trimmed) {
			renameError = $t('rename.empty');
			return;
		}
		const res = await fetch(`/api/listen/${docId}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: trimmed })
		});
		if (res.ok && doc) {
			doc = { ...doc, title: trimmed };
			renameOpen = false;
		} else {
			renameError = $t('common.error');
		}
	}

	function remove() {
		if (!doc) return;
		confirmRemoveOpen = true;
	}

	async function performRemove() {
		confirmRemoveOpen = false;
		const res = await fetch(`/api/listen/${docId}`, { method: 'DELETE' });
		if (res.ok) await goto('/listen');
	}

	function expiryDays(expiresAt: string): number {
		const ms = new Date(expiresAt.replace(' ', 'T') + 'Z').getTime() - Date.now();
		return Math.max(0, Math.ceil(ms / 86_400_000));
	}
</script>

<div class="reader">
	<a href="/listen" class="back-link">&larr; {$t('listen.back')}</a>

	{#if loading}
		<div class="center"><Spinner size={24} /></div>
	{:else if notFound || !doc}
		<p class="muted">{$t('listen.notFound')}</p>
	{:else}
		<div class="doc-head">
			<h1>{doc.title}</h1>
			<div class="head-actions">
				<button class="text-btn" onclick={rename}>{$t('listen.rename')}</button>
				<button class="text-btn danger" onclick={remove}>{$t('listen.delete')}</button>
			</div>
		</div>

		<div class="doc-sub">
			<span>{$t('listen.cachedCount', { cached: cachedNowCount, total: sentenceCount })}</span>
			<span>{$t('listen.charsLabel', { count: totalChars.toLocaleString() })}</span>
			<span class="expiry">{$t('listen.expiresIn', { days: expiryDays(doc.expires_at) })}</span>
		</div>

		<p class="legend">
			<span class="dot dot--cached"></span> {$t('listen.legendCached')}
			<span class="dot dot--listened"></span> {$t('listen.legendListened')}
			<span class="dot dot--default"></span> {$t('listen.legendDefault')}
		</p>

		<div class="text-body">
			{#each sentences as s (s.seq)}
				{#if editingSeq === s.seq}
					<div class="sentence-edit">
						<textarea class="edit-input" bind:value={editingText} rows="3"></textarea>
						<div class="edit-actions">
							<button class="edit-btn" onclick={() => saveEdit(s.seq)}>{$t('listen.saveEdit')}</button>
							<button class="edit-btn ghost" onclick={cancelEdit}>{$t('listen.cancel')}</button>
						</div>
					</div>
				{:else}
					<span
						class="sentence-wrap"
						class:farthest={maxSeq > 0 && s.seq === maxSeq}
						data-seq={s.seq}
					><button
						class="sentence"
						class:cached={s.cached}
						class:listened={listenedInSession.has(s.seq) && !s.cached}
						class:active={s.seq === activeSeq && playing}
						onclick={() => jumpTo(s.seq)}
						title={$t('listen.tapToJump')}
					>{s.text}</button><button
						class="edit-pencil"
						aria-label={$t('listen.edit')}
						onclick={() => startEdit(s.seq)}
					>✎</button> </span>
				{/if}
			{/each}
		</div>

		{#if errorMsg}
			<p class="error-text">{errorMsg}</p>
		{/if}

		<!-- Floating affordances: surface "scroll to top" and "jump to current sentence" only
		     when actually useful, so they never obstruct reading. -->
		<div class="float-bar" aria-hidden={!(scrolledAway || (playing && activeOffScreen))}>
			{#if scrolledAway}
				<button class="float-pill" onclick={scrollToTop} aria-label={$t('listen.scrollToTop')} title={$t('listen.scrollToTop')}>↑</button>
			{/if}
			{#if playing && activeOffScreen}
				<button class="float-pill primary" onclick={scrollToActive} aria-label={$t('listen.jumpToCurrent')}>
					● {$t('listen.jumpToCurrent')}
				</button>
			{/if}
		</div>

		<div class="player-bar">
			<button class="skip-btn" onclick={() => jumpTo(activeSeq - 1)} aria-label={$t('listen.previous')} disabled={activeSeq <= 0}>⏮</button>
			<button class="play-btn" onclick={() => togglePlay()} aria-label={playing ? $t('listen.pause') : $t('listen.play')}>
				{#if playing}❚❚{:else}▶{/if}
			</button>
			<button class="skip-btn" onclick={() => jumpTo(activeSeq + 1)} aria-label={$t('listen.next')} disabled={activeSeq >= sentences.length - 1}>⏭</button>
			<!-- Speed control. Two distinct mechanisms surfaced side by side:
			     - Playback rate (top section): client-side audio.playbackRate. Instant, free,
			       applies to already-cached sentences. Use this for "I want this faster, now".
			     - Generation speed (bottom section): ElevenLabs voice_settings.speed baked
			       into the synthesized audio at generation time. Different cache lane → using
			       a non-default speed re-synthesizes (and re-bills) sentences that haven't
			       been cached at that speed yet. Use this if the playback-rate audio sounds
			       choppy or unnatural. -->
			<div class="speed-wrap">
				<button
					class="speed-btn"
					onclick={() => (showSpeed = !showSpeed)}
					aria-haspopup="menu"
					aria-expanded={showSpeed}
					aria-label={$t('listen.speedAria')}
				>{playbackRate}×{genSpeed !== 1 ? ` · ${genSpeed}×` : ''}</button>
				{#if showSpeed}
					<div class="speed-pop" role="menu">
						<div class="speed-section">
							<div class="speed-section-head">
								<span class="speed-section-title">{$t('listen.playbackSpeed')}</span>
								<span class="speed-section-sub">{$t('listen.playbackSpeedSub')}</span>
							</div>
							<div class="speed-row">
								{#each [0.75, 1, 1.25, 1.5, 1.75, 2] as r}
									<button
										class="speed-opt"
										class:active={playbackRate === r}
										role="menuitemradio"
										aria-checked={playbackRate === r}
										onclick={() => onRateChange(r)}
									>{r}×</button>
								{/each}
							</div>
						</div>
						<div class="speed-section">
							<div class="speed-section-head">
								<span class="speed-section-title">{$t('listen.genSpeed')}</span>
								<span class="speed-section-sub speed-section-warn">{$t('listen.genSpeedSub')}</span>
							</div>
							<div class="speed-row">
								{#each [0.7, 0.85, 1, 1.15, 1.2] as g}
									<button
										class="speed-opt"
										class:active={genSpeed === g}
										role="menuitemradio"
										aria-checked={genSpeed === g}
										onclick={() => onGenSpeedChange(g)}
									>{g}×</button>
								{/each}
							</div>
						</div>
						<div class="speed-section">
							<button class="speed-close" onclick={() => (showSpeed = false)}>{$t('common.close')}</button>
						</div>
					</div>
				{/if}
			</div>
			<div class="progress">
				<div class="progress-line">
					<span>{activeSeq + 1} / {sentenceCount}</span>
					<span class="time" aria-hidden="true">{formatTime(elapsedMs)} / {formatTime(totalDurationMs)}</span>
				</div>
				<!-- Slider semantics so screen readers announce position; click-to-seek and arrow keys
				     for keyboard navigation. -->
				<button
					type="button"
					class="bar"
					role="slider"
					tabindex="0"
					aria-label={$t('listen.seekAria')}
					aria-valuemin="1"
					aria-valuemax={sentenceCount}
					aria-valuenow={activeSeq + 1}
					aria-valuetext={`${activeSeq + 1} / ${sentenceCount}`}
					onclick={onSeekClick}
					onkeydown={onSeekKey}
				>
					<div class="fill" style={`width:${(elapsedMs / Math.max(1, totalDurationMs)) * 100}%`}></div>
				</button>
				<div class="credit-line">
					<span class="spent">−{spentEstimate.toLocaleString()} {$t('listen.creditsShort')}</span>
					<span class="saved">{$t('listen.savedLabel', { count: savedEstimate.toLocaleString() })}</span>
				</div>
			</div>
		</div>

		<audio
			bind:this={audioEl}
			src={streamSrc}
			ontimeupdate={onTimeUpdate}
			onended={onEnded}
			onerror={onAudioError}
			onloadeddata={onAudioLoaded}
			preload="none"
		></audio>
	{/if}
</div>

<PromptDialog
	open={renameOpen}
	title={$t('rename.title')}
	label={$t('rename.label')}
	initialValue={doc?.title ?? ''}
	errorMessage={renameError}
	onsave={performRename}
	oncancel={() => (renameOpen = false)}
/>

<ConfirmDialog
	open={confirmRemoveOpen}
	title={$t('listen.delete')}
	message={doc ? $t('listen.deleteConfirm', { title: doc.title }) : ''}
	confirmLabel={$t('common.delete')}
	danger
	onconfirm={performRemove}
	oncancel={() => (confirmRemoveOpen = false)}
/>

<style>
	.reader { max-width: 720px; margin: 0 auto; padding-bottom: 7rem; }
	.back-link { color: var(--text-muted); text-decoration: none; font-size: 0.9rem; }
	.back-link:hover { color: var(--text); }
	.center { display: flex; justify-content: center; padding: 2rem 0; color: #8080c0; }
	.muted { color: #5a5a7a; }

	.doc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin: 1rem 0 0.5rem; }
	.doc-head h1 { font-size: 1.3rem; margin: 0; min-width: 0; overflow-wrap: anywhere; }
	.head-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
	.text-btn {
		background: none; border: none; color: #8d8db0; font-size: 0.82rem; cursor: pointer;
		padding: 0.5rem 0.6rem;
		min-height: 44px;
		display: inline-flex; align-items: center;
	}
	.text-btn:hover { color: var(--text); }
	.text-btn.danger:hover { color: #e07070; }

	.doc-sub { display: flex; flex-wrap: wrap; gap: 0.5rem 0.9rem; align-items: center; font-size: 0.8rem; color: #8d8db0; margin-bottom: 0.6rem; }
	.expiry { color: #6a6a8a; }

	.legend {
		display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 1rem;
		font-size: 0.72rem; color: var(--text-subtle); margin: 0 0 1rem;
	}
	.dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; display: inline-block; margin-right: 0.3rem; vertical-align: middle; }
	.dot--cached { background: var(--success); }
	.dot--listened { background: #7a8aa8; }
	.dot--default { background: var(--border); }

	.text-body {
		background: var(--bg);
		border: 1px solid var(--border-muted);
		border-radius: 12px;
		padding: 1rem 1.05rem;
		font-size: 1rem;
		line-height: 1.8;
		color: #d6d6f2;
	}

	.sentence-wrap { display: inline; }

	/**
	 * "Farthest ahead" marker: a small caret/line in the left margin next to the highest seq
	 * the user has ever reached. Subtle enough to read past, but visible when scanning back
	 * to "where was I". `position: relative` on the inline wrap is fine — the pseudo is
	 * absolute-positioned to the line, not the wrap.
	 */
	.sentence-wrap.farthest {
		position: relative;
		background: linear-gradient(to right, color-mix(in srgb, var(--warning) 28%, transparent), transparent 6em);
		border-radius: var(--r-sm);
		padding-left: 0.25rem;
		box-shadow: inset 3px 0 0 var(--warning);
	}

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

	/* Listened-but-not-cached: dotted slate underline so it's never confused with the
	   solid green of cached sentences. */
	.sentence.listened {
		border-bottom: 2px dotted #7a8aa8;
	}
	.sentence.cached {
		border-bottom: 2px solid var(--success);
	}
	.sentence.active {
		background: rgba(200, 168, 90, 0.28);
		border-bottom-color: #c8a85a;
	}

	.edit-pencil {
		background: none; border: none; color: #5a5a7a; font-size: 0.78rem;
		margin-left: 0.05rem; padding: 0 0.15rem; cursor: pointer; opacity: 0.4;
	}
	.edit-pencil:hover { opacity: 1; color: var(--text-muted); }

	.sentence-edit {
		display: block;
		background: var(--surface-2);
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		padding: 0.5rem;
		margin: 0.4rem 0;
	}
	.edit-input {
		width: 100%; box-sizing: border-box;
		background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
		color: var(--text); font: inherit; padding: 0.4rem 0.55rem; resize: vertical;
	}
	.edit-actions { display: flex; gap: 0.4rem; margin-top: 0.4rem; }
	.edit-btn {
		padding: 0.35rem 0.7rem; border-radius: 6px; border: 1px solid var(--border-strong);
		background: var(--primary); color: var(--text); font-size: 0.82rem; cursor: pointer; font-weight: 600;
	}
	.edit-btn.ghost { background: var(--surface); color: #a8a8c8; }

	.error-text { color: #cc6666; font-size: 0.85rem; margin: 0.6rem 0 0; }

	.player-bar {
		position: fixed; left: 0; right: 0; bottom: 0;
		background: #16162a;
		border-top: 1px solid var(--border-muted);
		padding: 0.7rem 0.9rem calc(0.7rem + env(safe-area-inset-bottom));
		display: flex; align-items: center; gap: 0.6rem;
		z-index: 20;
	}

	/* Floating affordances above the player. Sits at the bottom-right above the player bar,
	   never covers the seek progress, and respects iOS safe-area inset. */
	.float-bar {
		position: fixed;
		right: 0.75rem;
		bottom: calc(5.5rem + env(safe-area-inset-bottom));
		display: flex; flex-direction: column; gap: 0.4rem; align-items: flex-end;
		z-index: 21;
		pointer-events: none;
	}
	.float-bar[aria-hidden='true'] { display: none; }
	.float-pill {
		pointer-events: auto;
		background: var(--surface);
		border: 1px solid var(--border);
		color: var(--text);
		padding: 0.55rem 0.85rem;
		border-radius: var(--r-pill);
		font-size: 0.82rem; font-weight: 600;
		cursor: pointer;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
		min-height: 44px;
		display: inline-flex; align-items: center; gap: 0.35rem;
		touch-action: manipulation;
	}
	.float-pill.primary { background: var(--primary); border-color: var(--primary-hover); }
	.float-pill:hover { background: var(--primary-hover); border-color: var(--primary-hover); }

	/* Speed control: the popover sits above the player bar to the right of the skip controls. */
	.speed-wrap { position: relative; flex-shrink: 0; }
	.speed-btn {
		min-width: 44px; min-height: 44px;
		padding: 0 0.7rem;
		border-radius: var(--r-pill);
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text);
		font-size: 0.82rem; font-weight: 600;
		cursor: pointer;
		font-variant-numeric: tabular-nums;
		touch-action: manipulation;
	}
	.speed-btn:hover { border-color: var(--border-strong); }
	.speed-pop {
		position: absolute; bottom: calc(100% + 0.5rem); right: 0;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
		padding: 0.6rem;
		display: flex; flex-direction: column; gap: 0.5rem;
		width: 17rem; max-width: calc(100vw - 1.5rem);
		box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
		z-index: 22;
	}
	.speed-section { display: flex; flex-direction: column; gap: 0.35rem; }
	.speed-section + .speed-section { padding-top: 0.5rem; border-top: 1px solid var(--border-muted); }
	.speed-section-head { display: flex; flex-direction: column; gap: 0.1rem; padding: 0 0.1rem; }
	.speed-section-title { font-size: 0.85rem; font-weight: 600; color: var(--text); }
	.speed-section-sub { font-size: 0.72rem; color: var(--text-subtle); line-height: 1.3; }
	.speed-section-warn { color: var(--warning); }
	.speed-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 0.25rem; }
	.speed-section:nth-of-type(2) .speed-row { grid-template-columns: repeat(5, 1fr); }
	.speed-opt {
		background: var(--surface-2); border: 1px solid transparent; color: var(--text);
		padding: 0.5rem 0;
		text-align: center;
		border-radius: var(--r-sm);
		font-size: 0.8rem; cursor: pointer;
		font-variant-numeric: tabular-nums;
		min-height: 38px;
	}
	.speed-opt:hover { background: var(--surface-elevated); }
	.speed-opt.active { background: var(--primary); border-color: var(--primary-hover); color: var(--text); font-weight: 700; }
	.speed-close {
		background: none; border: 1px solid var(--border); color: var(--text-muted);
		padding: 0.4rem; border-radius: var(--r-sm);
		font-size: 0.78rem; cursor: pointer;
	}
	.speed-close:hover { border-color: var(--border-strong); color: var(--text); }

	.play-btn {
		flex-shrink: 0;
		width: 3rem; height: 3rem; border-radius: 50%;
		border: 1px solid var(--border-strong); background: var(--primary); color: var(--text);
		font-size: 1rem; cursor: pointer; display: flex; align-items: center; justify-content: center;
		touch-action: manipulation;
	}
	.skip-btn {
		flex-shrink: 0;
		/* 2.75rem ≈ 44px to clear the WCAG tap-target minimum. */
		width: 2.75rem; height: 2.75rem; border-radius: 50%;
		border: 1px solid var(--border); background: var(--surface); color: #c0c0e0;
		font-size: 0.85rem; cursor: pointer; display: flex; align-items: center; justify-content: center;
		touch-action: manipulation;
	}
	.skip-btn:disabled { opacity: 0.35; cursor: not-allowed; }

	.progress { flex: 1; display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
	.progress-line {
		font-size: 0.78rem; color: var(--text-muted);
		display: flex; justify-content: space-between; gap: 0.5rem;
	}
	.progress-line .time { font-variant-numeric: tabular-nums; color: var(--text-subtle); }
	/* Seekable bar: button styling reset + a generous click target via vertical padding while the
	   visible track stays thin. Padding doesn't grow the bar visually (height is fixed on .fill via
	   the parent's actual height) — it just makes the tap area easier to hit on mobile. */
	.bar {
		appearance: none;
		display: block;
		width: 100%;
		height: 10px;
		padding: 0;
		background: var(--border-muted);
		border: none;
		border-radius: var(--r-pill);
		overflow: hidden;
		cursor: pointer;
		touch-action: manipulation;
	}
	.bar:focus-visible { outline: 2px solid var(--border-strong); outline-offset: 2px; }
	.bar:hover .fill { background: #8181d0; }
	.fill { height: 100%; background: #6b6bc8; transition: width 0.15s linear, background 0.15s; pointer-events: none; }
	.credit-line { display: flex; gap: 0.7rem; font-size: 0.7rem; color: var(--text-subtle); }
	.spent { color: #c8a85a; }
	.saved { color: #5aba84; }
</style>

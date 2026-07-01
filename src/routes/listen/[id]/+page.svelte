<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { t } from '$lib/i18n';
	import Spinner from '$lib/components/Spinner.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import PromptDialog from '$lib/components/PromptDialog.svelte';
	import { elevenLabsModelCreditMultiplier } from '$lib/voice';
	import { estimateCredits } from '$lib/listen/estimate';
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
	/**
	 * True while the stream is buffering — most importantly during first-sentence synthesis
	 * right after play, or after jumping to an uncached sentence. Drives the spinner inside
	 * the play button and the "generating" shimmer on the active uncached sentence.
	 */
	let buffering = $state(false);
	let curTime = $state(0); // seconds since stream start (relative to streamStartSeq)
	let editingSeq = $state<number | null>(null);
	let editingText = $state('');
	let pollHandle: ReturnType<typeof setInterval> | null = null;

	// Per-document persisted progress: where you last paused (lastSeq) and the farthest you've
	// ever reached (maxSeq, used for the resume banner). Restored on mount so reopening a long
	// document drops you back where you were instead of at the top.
	const PROGRESS_KEY = $derived(`listen-progress:${docId}`);
	let maxSeq = $state(0);
	let resumeDismissed = $state(false);

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
	let speedWrapEl = $state<HTMLElement | null>(null);

	/* The speed popover has no backdrop, so dismiss it like a native menu: Escape or any
	 * pointer press outside its wrapper. */
	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && showSpeed) showSpeed = false;
	}

	function onWindowPointerdown(e: PointerEvent) {
		if (showSpeed && speedWrapEl && !speedWrapEl.contains(e.target as Node)) showSpeed = false;
	}

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

	/**
	 * Estimated credits still to be spent to finish the document from the current position:
	 * everything at or after the active sentence that isn't cached yet will bill at the
	 * model's per-character rate when reached. Hidden in the UI when zero.
	 */
	const creditsToFinish = $derived.by(() => {
		if (!doc || !sentences.length) return 0;
		const chars = sentences
			.filter((s) => s.seq >= activeSeq && !s.cached)
			.reduce((sum, s) => sum + s.char_count, 0);
		return chars > 0 ? estimateCredits(chars, doc.tts_model) : 0;
	});

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
				album: sentences[activeSeq]?.text.slice(0, 60) ?? '',
				// PWA icons double as the lock-screen / notification artwork.
				artwork: [
					{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
					{ src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png' }
				]
			});
			navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
		} catch { /* no-op */ }
	}

	async function startStream(fromSeq: number) {
		streamStartSeq = fromSeq;
		curTime = 0;
		errorMsg = '';
		// Assume we're synthesizing until the element reports playable data — first-sentence
		// generation takes a few seconds and this is what surfaces the spinner immediately.
		buffering = true;
		// Pass the generation speed so the server picks the right cache lane and (on misses)
		// synthesizes at that tempo.
		streamSrc = `/api/listen/${docId}/stream?from=${fromSeq}&speed=${genSpeed}`;
		await tick();
		if (!audioEl) {
			buffering = false;
			return;
		}
		audioEl.load();
		try {
			await audioEl.play();
			playing = true;
			startPolling();
			updateMediaMetadata();
		} catch {
			playing = false;
			buffering = false;
		}
	}

	/**
	 * Hard-close the server stream (set src=''  + load) so the worker loop doesn't keep
	 * generating sentences past the user's pause point. Without this, browsers buffer
	 * 30–60s ahead of playback and the server happily burns credits filling that buffer.
	 */
	function closeStream() {
		streamSrc = '';
		buffering = false;
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
			// After a pause the stream was closed; reopen from where we left off. Also covers
			// the case where a prior stream errored and was cleared in `onAudioError`.
			if (!streamSrc) {
				await startStream(activeSeq);
				return;
			}
			try {
				buffering = true;
				await audioEl?.play();
				playing = true;
				errorMsg = '';
				startPolling();
				updateMediaMetadata();
			} catch {
				// play() can reject if the underlying element is in an unrecoverable state
				// (e.g. a prior network error drained it). Open a fresh stream so the user
				// isn't stuck pressing a dead play button.
				playing = false;
				buffering = false;
				await startStream(activeSeq);
			}
		} else {
			playing = false;
			buffering = false;
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

	const remainingMs = $derived(Math.max(0, totalDurationMs - elapsedMs));

	/**
	 * Buffered-style underlay for the seek bar: cached (free) regions paint as a faint white
	 * wash, uncached (paid) regions stay transparent. Built as one linear-gradient with hard
	 * stops from cumulative durations; consecutive same-state sentences merge into a single
	 * run so the gradient stays small even for long documents. Recomputes whenever the
	 * sentence poll refreshes cache flags.
	 */
	const cacheGradient = $derived.by(() => {
		if (!sentences.length || totalDurationMs <= 0) return '';
		const stops: string[] = [];
		let runStart = 0;
		let runCached = sentences[0].cached;
		let acc = 0;
		const flush = (endMs: number) => {
			const from = ((runStart / totalDurationMs) * 100).toFixed(2);
			const to = ((endMs / totalDurationMs) * 100).toFixed(2);
			stops.push(`${runCached ? 'rgba(255, 255, 255, 0.14)' : 'transparent'} ${from}% ${to}%`);
		};
		for (const s of sentences) {
			if (s.cached !== runCached) {
				flush(acc);
				runStart = acc;
				runCached = s.cached;
			}
			acc += s.duration_ms;
		}
		flush(acc);
		return `linear-gradient(to right, ${stops.join(', ')})`;
	});

	/**
	 * Whether the user has an established position in the document (mid-playback pause or a
	 * restored session). Gates the subdued paused-highlight so a freshly opened, never-played
	 * document doesn't highlight its first sentence for no reason.
	 */
	const hasPosition = $derived(curTime > 0 || streamStartSeq > 0);

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

	/**
	 * Buffering feedback. `waiting`/`stalled` fire when the element runs out of decoded data —
	 * with this streaming endpoint that means the server is synthesizing the next uncached
	 * sentence. `canplay`/`playing` mean audio is flowing again. Guarded on `streamSrc` so the
	 * teardown in `closeStream()` (which fires spurious events) can't re-light the spinner.
	 */
	function onAudioWaiting() {
		if (streamSrc) buffering = true;
	}

	function onAudioReady() {
		buffering = false;
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
		buffering = false;
		stopPolling();
		updateMediaMetadata();
		refreshSentences();
	}

	async function onAudioError() {
		// Suppress the spurious error fired by closeStream() — when the user pauses we call
		// removeAttribute('src') + load(), which raises a MEDIA_ERR_* with no real failure
		// underneath. By that point streamSrc has already been cleared, so this check
		// distinguishes "we intentionally tore down the element" from "a real load failed
		// while we were trying to play". Same guard catches the initial-mount empty-src case.
		if (!streamSrc) return;
		// Hard-reset the element so the next play attempt opens a fresh stream instead of
		// retrying the dead source (which would silently no-op until reload).
		playing = false;
		buffering = false;
		stopPolling();
		const wasAt = activeSeq;
		streamSrc = '';
		errorMsg = $t('listen.streamError');
		// Probe the same URL to surface the actual reason. The audio element only emits a
		// generic MEDIA_ERR_*; a follow-up fetch gives us the real HTTP status.
		try {
			const probe = await fetch(`/api/listen/${docId}/stream?from=${wasAt}&speed=${genSpeed}`, {
				headers: { Range: 'bytes=0-0' }
			});
			probe.body?.cancel().catch(() => undefined);
			if (probe.status === 429) errorMsg = $t('listen.rateLimited');
			else if (probe.status === 400) errorMsg = $t('listen.noKey');
			else if (probe.status === 401) errorMsg = $t('listen.streamError');
		} catch {
			/* network down: leave generic message */
		}
	}

	/** Retry button on the error banner: reopen the stream from the current position. */
	async function retryStream() {
		errorMsg = '';
		await startStream(activeSeq);
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

	/**
	 * Resume CTA: jump playback to the farthest sentence the user has previously reached.
	 * Only meaningful when we're currently behind that point — see `showResumeBanner` below.
	 */
	async function resumeFromMax() {
		resumeDismissed = true;
		await jumpTo(maxSeq);
	}

	const showResumeBanner = $derived(
		!resumeDismissed && !playing && maxSeq > 0 && maxSeq > activeSeq && maxSeq < sentences.length
	);
</script>

<svelte:window onkeydown={onWindowKeydown} onpointerdown={onWindowPointerdown} />

<div class="reader">
	<a href="/listen" class="back-link">&larr; {$t('listen.back')}</a>

	{#if loading}
		<!-- Text-block skeleton mirroring the reader layout (title, meta line, paragraph card)
		     so the page doesn't collapse to a lone spinner while the document loads. -->
		<div class="doc-skeleton" role="status" aria-label={$t('common.loading')}>
			<div class="skel skel-title" aria-hidden="true"></div>
			<div class="skel skel-meta" aria-hidden="true"></div>
			<div class="skel-block" aria-hidden="true">
				{#each [97, 100, 92, 99, 88, 100, 95, 62] as w, i (i)}
					<div class="skel skel-line" style={`width:${w}%`}></div>
				{/each}
			</div>
		</div>
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

		{#if showResumeBanner}
			<div class="resume-banner" role="region" aria-label={$t('listen.resumeFromTitle')}>
				<div class="resume-text">
					<strong>{$t('listen.resumeFromTitle')}</strong>
					<span>{$t('listen.resumeFromHint', { from: maxSeq + 1, total: sentenceCount })}</span>
				</div>
				<button class="resume-btn" onclick={resumeFromMax}>{$t('listen.resumeAction')}</button>
				<button class="resume-dismiss" onclick={() => (resumeDismissed = true)} aria-label={$t('common.dismiss')}>×</button>
			</div>
		{/if}

		<div class="text-body">
			{#each sentences as s (s.seq)}
				{#if editingSeq === s.seq}
					<div class="sentence-edit">
						<textarea class="edit-input" bind:value={editingText} rows="3"></textarea>
						<div class="edit-actions">
							<button class="btn-primary edit-btn" onclick={() => saveEdit(s.seq)}>{$t('listen.saveEdit')}</button>
							<button class="btn-secondary edit-btn" onclick={cancelEdit}>{$t('listen.cancel')}</button>
						</div>
					</div>
				{:else}
					<span
						class="sentence-wrap"
						data-seq={s.seq}
					><button
						class="sentence"
						class:cached={s.cached}
						class:listened={listenedInSession.has(s.seq) && !s.cached}
						class:active={s.seq === activeSeq && playing}
						class:paused={s.seq === activeSeq && !playing && hasPosition}
						class:generating={s.seq === activeSeq && buffering && !s.cached}
						onclick={() => jumpTo(s.seq)}
						title={$t('listen.tapToJump')}
					>{s.text}</button><button
						class="edit-pencil"
						aria-label={$t('listen.edit')}
						onclick={() => startEdit(s.seq)}
					><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button> </span>
				{/if}
			{/each}
		</div>

		<!-- Sticky error notice: sits above the player so it's visible regardless of scroll
		     position. Includes Retry — the underlying `streamSrc` was cleared in `onAudioError`
		     so retry opens a fresh stream from the current sentence. -->
		{#if errorMsg}
			<div class="error-toast" role="alert">
				<span class="error-toast-msg">{errorMsg}</span>
				<button class="error-toast-retry" onclick={retryStream}>{$t('listen.retry')}</button>
				<button class="error-toast-dismiss" onclick={() => (errorMsg = '')} aria-label={$t('common.dismiss')}>×</button>
			</div>
		{/if}

		<!-- Floating affordances: surface "scroll to top" and "jump to current sentence" only
		     when actually useful, so they never obstruct reading. -->
		<div class="float-bar" aria-hidden={!(scrolledAway || (playing && activeOffScreen))}>
			{#if scrolledAway}
				<button class="float-pill icon-only" onclick={scrollToTop} aria-label={$t('listen.scrollToTop')} title={$t('listen.scrollToTop')}>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
				</button>
			{/if}
			{#if playing && activeOffScreen}
				<button class="float-pill primary" onclick={scrollToActive} aria-label={$t('listen.jumpToCurrent')}>
					<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><circle cx="5" cy="5" r="4"/></svg>
					<span>{$t('listen.jumpToCurrent')}</span>
				</button>
			{/if}
		</div>

		<div class="player-bar">
			<button class="skip-btn" onclick={() => jumpTo(activeSeq - 1)} aria-label={$t('listen.previous')} disabled={activeSeq <= 0}>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="19 20 9 12 19 4 19 20"/><rect x="4" y="4" width="2" height="16" rx="0.5"/></svg>
			</button>
			<button
				class="play-btn"
				onclick={() => togglePlay()}
				aria-label={buffering ? $t('listen.buffering') : playing ? $t('listen.pause') : $t('listen.play')}
				aria-busy={buffering}
			>
				{#if buffering}
					<Spinner size={20} />
				{:else if playing}
					<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
				{:else}
					<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 4 20 12 6 20 6 4"/></svg>
				{/if}
			</button>
			<button class="skip-btn" onclick={() => jumpTo(activeSeq + 1)} aria-label={$t('listen.next')} disabled={activeSeq >= sentences.length - 1}>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 4 15 12 5 20 5 4"/><rect x="18" y="4" width="2" height="16" rx="0.5"/></svg>
			</button>
			<!-- Speed control. Two distinct mechanisms:
			     - Playback rate (always visible): client-side audio.playbackRate. Instant, free,
			       applies to already-cached sentences. Use this for "I want this faster, now".
			     - Generation speed (behind the disclosure): ElevenLabs voice_settings.speed baked
			       into the synthesized audio at generation time. Different cache lane → using
			       a non-default speed re-synthesizes (and re-bills) sentences that haven't
			       been cached at that speed yet. Expert control, so it's tucked away; a dot
			       badge on the pill signals when it's active. -->
			<div class="speed-wrap" bind:this={speedWrapEl}>
				<button
					class="speed-btn"
					onclick={() => (showSpeed = !showSpeed)}
					aria-haspopup="menu"
					aria-expanded={showSpeed}
					aria-label={$t('listen.speedAria')}
					title={genSpeed !== 1 ? $t('listen.genSpeedActive', { speed: genSpeed }) : undefined}
				>
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.5A8.5 8.5 0 1 0 3.5 14.5"/><path d="M12 13.5 15.5 10"/></svg>
					<span class="speed-val">{playbackRate}×</span>
					{#if genSpeed !== 1}<span class="gen-dot" aria-hidden="true"></span>{/if}
				</button>
				{#if showSpeed}
					<div class="speed-pop" role="menu">
						<div class="speed-section">
							<div class="speed-section-head">
								<span class="speed-section-title">{$t('listen.playbackSpeed')}</span>
								<span class="speed-section-sub">{$t('listen.playbackSpeedSub')}</span>
							</div>
							<div class="speed-row">
								{#each [0.75, 1, 1.25, 1.5, 1.75, 2] as r (r)}
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
						<details class="gen-disclosure" open={genSpeed !== 1}>
							<summary>
								<span class="speed-section-title">{$t('listen.genSpeed')}</span>
								{#if genSpeed !== 1}<span class="gen-badge">{genSpeed}×</span>{/if}
								<svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
							</summary>
							<p class="speed-section-sub speed-section-warn">{$t('listen.genSpeedSub')}</p>
							<div class="speed-row gen-row">
								{#each [0.7, 0.85, 1, 1.15, 1.2] as g (g)}
									<button
										class="speed-opt"
										class:active={genSpeed === g}
										role="menuitemradio"
										aria-checked={genSpeed === g}
										onclick={() => onGenSpeedChange(g)}
									>{g}×</button>
								{/each}
							</div>
						</details>
						<div class="speed-section">
							<button class="speed-close" onclick={() => (showSpeed = false)}>{$t('common.close')}</button>
						</div>
					</div>
				{/if}
			</div>
			<div class="progress">
				<div class="progress-line">
					<span>{activeSeq + 1} / {sentenceCount}</span>
					<span class="time" aria-hidden="true">
						{formatTime(elapsedMs)} / {formatTime(totalDurationMs)}
						<span class="remaining" title={$t('listen.remainingTime')}>−{formatTime(remainingMs)}</span>
					</span>
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
					{#if cacheGradient}
						<div class="cache-layer" style={`background-image:${cacheGradient}`}></div>
					{/if}
					<div class="fill" style={`width:${(elapsedMs / Math.max(1, totalDurationMs)) * 100}%`}></div>
				</button>
				{#if creditsToFinish > 0 || spentEstimate > 0 || savedEstimate > 0}
					<div class="credit-line">
						{#if creditsToFinish > 0}
							<span class="to-finish">{$t('listen.creditsToFinish', { count: creditsToFinish.toLocaleString() })}</span>
						{/if}
						{#if spentEstimate > 0}
							<span class="spent">−{spentEstimate.toLocaleString()} {$t('listen.creditsShort')}</span>
						{/if}
						{#if savedEstimate > 0}
							<span class="saved">{$t('listen.savedLabel', { count: savedEstimate.toLocaleString() })}</span>
						{/if}
					</div>
				{/if}
			</div>
		</div>

		<audio
			bind:this={audioEl}
			src={streamSrc}
			ontimeupdate={onTimeUpdate}
			onended={onEnded}
			onerror={onAudioError}
			onloadeddata={onAudioLoaded}
			onwaiting={onAudioWaiting}
			onstalled={onAudioWaiting}
			oncanplay={onAudioReady}
			onplaying={onAudioReady}
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
	.reader { max-width: 720px; margin: 0 auto; padding-bottom: 9rem; }
	.back-link { color: var(--text-muted); text-decoration: none; font-size: 0.9rem; }
	.back-link:hover { color: var(--text); }
	.muted { color: var(--text-subtle); }

	/* Loading skeleton (uses the global shimmer keyframes from app.css). */
	.doc-skeleton { margin-top: 1rem; display: flex; flex-direction: column; gap: 0.6rem; }
	.skel {
		border-radius: var(--r-sm);
		background: linear-gradient(90deg, var(--surface) 25%, var(--surface-elevated) 50%, var(--surface) 75%);
		background-size: 200% 100%;
		animation: shimmer 1.6s linear infinite;
	}
	.skel-title { height: 1.4rem; width: 55%; }
	.skel-meta { height: 0.8rem; width: 38%; margin-bottom: 0.3rem; }
	.skel-block {
		border: 1px solid var(--border-muted);
		border-radius: var(--r-lg);
		padding: 1.1rem 1.05rem;
		display: flex; flex-direction: column; gap: 0.85rem;
	}
	.skel-line { height: 0.9rem; }

	.doc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin: 1rem 0 0.5rem; }
	.doc-head h1 { font-size: 1.3rem; margin: 0; min-width: 0; overflow-wrap: anywhere; }
	.head-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
	.text-btn {
		background: none; border: none; color: var(--text-muted); font-size: 0.82rem; cursor: pointer;
		padding: 0.5rem 0.6rem;
		min-height: 44px;
		display: inline-flex; align-items: center;
	}
	.text-btn:hover { color: var(--text); }
	.text-btn.danger:hover { color: var(--danger-soft); }

	.doc-sub { display: flex; flex-wrap: wrap; gap: 0.5rem 0.9rem; align-items: center; font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.6rem; }
	.expiry { color: var(--text-subtle); }

	.legend {
		display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 1rem;
		font-size: 0.72rem; color: var(--text-subtle); margin: 0 0 1rem;
	}
	.dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; display: inline-block; margin-right: 0.3rem; vertical-align: middle; }
	.dot--cached { background: var(--success); }
	.dot--listened { background: var(--text-subtle); }
	.dot--default { background: var(--border); }

	.text-body {
		background: var(--bg);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-lg);
		padding: 1rem 1.05rem;
		font-size: 1rem;
		line-height: 1.8;
		color: var(--text);
	}

	.sentence-wrap { display: inline; }

	/* Resume banner: replaces the previous inline "farthest" marker (which painted a
	   per-line gradient that doubled up with the active highlight on multi-line sentences).
	   A single top-of-document CTA is clearer and addresses the "no resume button" gap. */
	.resume-banner {
		display: flex; align-items: center; gap: 0.7rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-left: 3px solid var(--primary);
		border-radius: var(--r-md);
		padding: 0.6rem 0.8rem;
		margin-bottom: 0.9rem;
	}
	.resume-text { display: flex; flex-direction: column; flex: 1; min-width: 0; gap: 0.1rem; }
	.resume-text strong { font-size: 0.9rem; color: var(--text); }
	.resume-text span { font-size: 0.78rem; color: var(--text-muted); }
	.resume-btn {
		background: var(--primary); color: var(--text-on-primary);
		border: none; border-radius: var(--r-pill);
		padding: 0.5rem 0.95rem;
		font-size: 0.85rem; font-weight: 600;
		cursor: pointer; min-height: 36px;
		touch-action: manipulation;
	}
	.resume-btn:hover { background: var(--primary-hover); }
	.resume-dismiss {
		background: none; border: none; color: var(--text-muted);
		font-size: 1.2rem; line-height: 1; cursor: pointer;
		padding: 0.25rem 0.4rem;
	}
	.resume-dismiss:hover { color: var(--text); }

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
		border-radius: var(--r-sm);
		border-bottom: 2px solid transparent;
		transition: background var(--t-med) var(--ease), border-color var(--t-med) var(--ease);
		-webkit-tap-highlight-color: transparent;
	}
	.sentence:hover { background: rgba(255, 255, 255, 0.08); }

	/* Listened-but-not-cached: dotted underline so it's never confused with the
	   solid green of cached sentences. */
	.sentence.listened {
		border-bottom: 2px dotted var(--text-subtle);
	}
	.sentence.cached {
		border-bottom: 2px solid var(--success);
	}
	/* Subdued position marker while paused — dimmer than the playing highlight so users
	   keep their place without the page shouting "now playing". */
	.sentence.paused {
		background: rgba(255, 255, 255, 0.06);
		border-bottom-color: var(--text-subtle);
	}
	.sentence.active {
		background: rgba(255, 255, 255, 0.12);
		border-bottom-color: var(--text);
	}
	/* Active-but-uncached sentence while the stream buffers: the server is synthesizing this
	   sentence right now, so give it a gentle shimmer (global keyframes; compressed to a
	   single pass under prefers-reduced-motion). */
	.sentence.generating {
		background-image: linear-gradient(
			90deg,
			rgba(255, 255, 255, 0.04) 25%,
			rgba(255, 255, 255, 0.16) 50%,
			rgba(255, 255, 255, 0.04) 75%
		);
		background-size: 200% 100%;
		animation: shimmer 1.4s linear infinite;
	}

	.edit-pencil {
		background: none; border: none; color: var(--text-subtle);
		margin-left: 0.05rem; padding: 0 0.2rem; cursor: pointer; opacity: 0.4;
		display: inline-flex; align-items: center; vertical-align: middle;
	}
	.edit-pencil:hover { opacity: 1; color: var(--text-muted); }

	.sentence-edit {
		display: block;
		background: var(--surface-2);
		border: 1px solid var(--border-strong);
		border-radius: var(--r-md);
		padding: 0.5rem;
		margin: 0.4rem 0;
	}
	.edit-input {
		width: 100%; box-sizing: border-box;
		background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm);
		color: var(--text); font: inherit; padding: 0.4rem 0.55rem; resize: vertical;
	}
	.edit-input:focus { outline: none; border-color: var(--border-strong); }
	.edit-actions { display: flex; gap: 0.4rem; margin-top: 0.4rem; }
	/* Compact variants of the global button recipes for the inline edit card. */
	.edit-btn { padding: 0.4rem 0.8rem; font-size: 0.82rem; }

	/* Sticky error toast above the player. Pinned so the user sees it regardless of where
	   they've scrolled when playback fails — the previous inline `.error-text` was easy to
	   miss in a long document. */
	.error-toast {
		position: fixed;
		left: 0.6rem; right: 0.6rem;
		bottom: calc(5.4rem + env(safe-area-inset-bottom));
		background: var(--surface-elevated);
		border: 1px solid var(--danger-border);
		color: var(--text);
		padding: 0.6rem 0.75rem;
		border-radius: var(--r-md);
		display: flex; align-items: center; gap: 0.6rem;
		box-shadow: var(--shadow-md);
		z-index: 23;
		font-size: 0.85rem;
	}
	.error-toast-msg { flex: 1; min-width: 0; }
	.error-toast-retry {
		background: var(--danger); color: var(--text-on-primary);
		border: none; border-radius: var(--r-pill);
		padding: 0.4rem 0.85rem;
		font-size: 0.8rem; font-weight: 600;
		cursor: pointer;
		min-height: 36px;
		touch-action: manipulation;
	}
	.error-toast-retry:hover { background: var(--danger-hover); }
	.error-toast-dismiss {
		background: none; border: none; color: var(--text-muted);
		font-size: 1.2rem; line-height: 1; cursor: pointer;
		padding: 0.25rem 0.4rem;
	}
	.error-toast-dismiss:hover { color: var(--text); }

	/* Translucent player bar: content scrolls underneath the blur, ElevenLabs-style.
	   flex-wrap + the narrow-viewport rules below reflow the progress block onto its own
	   row under 420px so nothing overflows at 320px. */
	.player-bar {
		position: fixed; left: 0; right: 0; bottom: 0;
		background: rgba(10, 10, 10, 0.9);
		-webkit-backdrop-filter: blur(16px);
		backdrop-filter: blur(16px);
		border-top: 1px solid var(--border-muted);
		padding: 0.7rem 0.9rem calc(0.7rem + env(safe-area-inset-bottom));
		display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.6rem;
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
		box-shadow: var(--shadow-md);
		min-height: 44px;
		display: inline-flex; align-items: center; gap: 0.35rem;
		touch-action: manipulation;
	}
	.float-pill:hover { background: var(--surface-elevated); border-color: var(--border-strong); }
	.float-pill.primary { background: var(--primary); border-color: transparent; color: var(--text-on-primary); }
	.float-pill.primary:hover { background: var(--primary-hover); border-color: transparent; }
	/* When the pill is only an icon (scroll-to-top) shrink horizontal padding so the icon
	   sits in a square 44×44 target instead of an awkwardly wide pill. */
	.float-pill.icon-only { padding: 0.55rem; min-width: 44px; justify-content: center; }

	/* Speed control: the popover sits above the player bar to the right of the skip controls. */
	.speed-wrap { position: relative; flex-shrink: 0; }
	.speed-btn {
		position: relative;
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
		display: inline-flex; align-items: center; gap: 0.35rem;
	}
	.speed-btn:hover { border-color: var(--border-strong); }
	/* Dot badge signalling a non-default generation speed is active (details in the popover). */
	.gen-dot {
		position: absolute; top: 5px; right: 7px;
		width: 6px; height: 6px; border-radius: 50%;
		background: var(--warning);
	}
	/* Fixed to the viewport, not to the speed button. The button sits in the middle of the
	   player bar, so anchoring `right: 0` to it pushed the 17rem popover off-screen on
	   mobile. Docking to the bottom-right of the viewport keeps the whole panel visible
	   regardless of how the player bar lays out. */
	.speed-pop {
		position: fixed;
		bottom: calc(5.4rem + env(safe-area-inset-bottom));
		right: 0.6rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
		padding: 0.6rem;
		display: flex; flex-direction: column; gap: 0.5rem;
		width: 17rem; max-width: calc(100vw - 1.2rem);
		box-shadow: var(--shadow-lg);
		z-index: 24;
		transform-origin: bottom right;
		animation: pop var(--t-med) var(--ease);
	}
	.speed-section { display: flex; flex-direction: column; gap: 0.35rem; }
	.speed-section-head { display: flex; flex-direction: column; gap: 0.1rem; padding: 0 0.1rem; }
	.speed-section-title { font-size: 0.85rem; font-weight: 600; color: var(--text); }
	.speed-section-sub { font-size: 0.72rem; color: var(--text-subtle); line-height: 1.3; }
	.speed-section-warn { color: var(--warning); }
	/* Generation speed is an expert control (re-bills credits), so it lives behind a
	   native disclosure instead of sitting next to the everyday playback rate. */
	.gen-disclosure { border-top: 1px solid var(--border-muted); padding-top: 0.5rem; }
	.gen-disclosure summary {
		list-style: none;
		display: flex; align-items: center; gap: 0.4rem;
		cursor: pointer;
		min-height: 32px;
		padding: 0 0.1rem;
	}
	.gen-disclosure summary::-webkit-details-marker { display: none; }
	.gen-disclosure .chevron { margin-left: auto; color: var(--text-subtle); transition: transform var(--t-fast) var(--ease); }
	.gen-disclosure[open] .chevron { transform: rotate(180deg); }
	.gen-badge {
		font-size: 0.72rem; font-weight: 700;
		color: var(--warning); background: var(--warning-tint);
		border: 1px solid var(--warning-border);
		border-radius: var(--r-pill);
		padding: 0.05rem 0.4rem;
		font-variant-numeric: tabular-nums;
	}
	.gen-disclosure .speed-section-sub { display: block; margin: 0.15rem 0.1rem 0.4rem; }
	.speed-row { display: grid; grid-template-columns: repeat(6, 1fr); gap: 0.25rem; }
	.speed-row.gen-row { grid-template-columns: repeat(5, 1fr); }
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
	.speed-opt.active { background: var(--primary); border-color: transparent; color: var(--text-on-primary); font-weight: 700; }
	.speed-close {
		background: none; border: 1px solid var(--border); color: var(--text-muted);
		padding: 0.4rem; border-radius: var(--r-sm);
		font-size: 0.78rem; cursor: pointer;
	}
	.speed-close:hover { border-color: var(--border-strong); color: var(--text); }

	/* The signature control: white circle, inverted icon. */
	.play-btn {
		flex-shrink: 0;
		width: 3rem; height: 3rem; border-radius: 50%;
		border: none;
		background: var(--primary); color: var(--text-on-primary);
		box-shadow: var(--shadow-sm);
		cursor: pointer; display: flex; align-items: center; justify-content: center;
		touch-action: manipulation;
		transition: background var(--t-fast) var(--ease), transform 80ms var(--ease);
	}
	.play-btn:hover { background: var(--primary-hover); }
	.play-btn:active { transform: scale(0.94); }
	.skip-btn {
		flex-shrink: 0;
		/* 2.75rem ≈ 44px to clear the WCAG tap-target minimum. */
		width: 2.75rem; height: 2.75rem; border-radius: 50%;
		border: 1px solid var(--border); background: var(--surface); color: var(--text);
		font-size: 0.85rem; cursor: pointer; display: flex; align-items: center; justify-content: center;
		touch-action: manipulation;
	}
	.skip-btn:hover:not(:disabled) { border-color: var(--border-strong); }
	.skip-btn:disabled { opacity: 0.35; cursor: not-allowed; }

	.progress { flex: 1; display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
	.progress-line {
		font-size: 0.78rem; color: var(--text-muted);
		display: flex; justify-content: space-between; gap: 0.5rem;
		font-variant-numeric: tabular-nums;
	}
	.progress-line .time { color: var(--text-subtle); white-space: nowrap; }
	.progress-line .remaining { color: var(--text-muted); margin-left: 0.35rem; }
	/* Seekable bar: button styling reset + a thin visible track. The layered children paint,
	   bottom to top: cached-region underlay (faint white = free replay), then the white
	   progress fill. */
	.bar {
		appearance: none;
		position: relative;
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
	.bar:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
	.cache-layer { position: absolute; inset: 0; pointer-events: none; }
	.fill {
		position: relative;
		height: 100%;
		background: var(--primary);
		color: var(--text-on-primary);
		transition: width 0.15s linear;
		pointer-events: none;
	}
	.credit-line { display: flex; flex-wrap: wrap; gap: 0.15rem 0.7rem; font-size: 0.7rem; color: var(--text-subtle); }
	.to-finish { color: var(--text-muted); }
	.spent { color: var(--warning); }
	.saved { color: var(--success); }

	/* Narrow phones (<420px): the row of controls + inline progress overflows at 320px, so
	   the progress block (counts, seek bar, credits) reflows onto its own full-width row and
	   the speed pill docks right. Fixed overlays shift up to clear the now-taller bar. */
	@media (max-width: 419px) {
		.progress { flex-basis: 100%; }
		.speed-wrap { margin-left: auto; }
		.speed-pop { bottom: calc(9.2rem + env(safe-area-inset-bottom)); }
		.error-toast { bottom: calc(9rem + env(safe-area-inset-bottom)); }
		.float-bar { bottom: calc(9.2rem + env(safe-area-inset-bottom)); }
	}
</style>

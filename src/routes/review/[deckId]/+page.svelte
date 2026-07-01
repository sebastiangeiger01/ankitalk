<script lang="ts">
	import { page } from '$app/stores';
	import { onDestroy } from 'svelte';
	import { fade } from 'svelte/transition';
	import { createReviewEngine, type ReviewEvent, type SessionStats, type StartOptions, type IntervalLabels, type QueueCounts, type PrefetchedCards } from '$lib/client/review-engine';
	import { preloadTTS, unlockAudioForGesture } from '$lib/client/audio';
	import { getPrepareAudioAhead } from '$lib/client/preferences';
	import { locale, t } from '$lib/i18n';
	import { focusTrap } from '$lib/actions/focusTrap';
	import { clientCardSanitizer } from '$lib/client/card-sanitize';
	import { renderCard } from '$lib/client/card-renderer';
	import type { ReviewPhase } from '$lib/types';
	import { sttLanguageForVoiceCommandLanguage, type UserVoiceSettings } from '$lib/voice';
	import AgentChat from '$lib/components/AgentChat.svelte';

	let agentChatOpen = $state(false);
	let agentEnabled = $state(false);
	let tutorPausedReviewMic = false;
	// Tutor context — populated from each card_change emit so the agent receives current
	// card identifiers + scheduling state, not just front/back.
	let agentCardId = $state('');

	/**
	 * Strip HTML so the agent receives clean text in its dynamic variables. The cards are
	 * Anki-shaped — they can contain inline markup, cloze braces, audio refs — none of
	 * which the tutor should see verbatim. We don't sanitize for safety here (the agent
	 * isn't rendering HTML); we just want the spoken-aloud text.
	 */
	function plainText(html: string): string {
		return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
	}

	const deckId = $derived($page.params.deckId);

	let started = $state(false);
	let phase = $state<ReviewPhase>('question');
	let status = $state<'idle' | 'loading' | 'speaking' | 'listening' | 'waiting'>('idle');
	let cardsReviewed = $state(0);
	let frontText = $state('');
	let backText = $state('');
	let frontHtml = $state('');
	let backHtml = $state('');
	let errorMsg = $state('');
	let errorTimer: ReturnType<typeof setTimeout> | null = null;
	let sessionEnded = $state(false);
	let stats = $state<SessionStats | null>(null);
	let deckName = $state('');
	let micOn = $state(true);
	let audioOn = $state(true);
	let undoAvailable = $state(false);
	let cardState = $state<'new' | 'learning' | 'review' | null>(null);
	let learningCountdown = $state(0);
	let countdownInterval: ReturnType<typeof setInterval> | null = null;
	let suspendedNotice = $state('');
	let suspendedTimer: ReturnType<typeof setTimeout> | null = null;
	let tagFilter = $state('');
	let cramMode = $state(false);
	let cramState = $state<'' | 'new' | 'learning' | 'review'>('');
	let intervals = $state<IntervalLabels>({ again: '', hard: '', good: '', easy: '' });
	let counts = $state<QueueCounts>({ new: 0, learning: 0, review: 0 });
	let helpOpen = $state(false);
	let shortcutsOpen = $state(false);
	let prefetchedCards = $state<PrefetchedCards | null>(null);
	let reviewPrepared = $state(false);
	let highlightRating = $state<string>('');
	let highlightTimer: ReturnType<typeof setTimeout> | null = null;
	type ApiKeyStatus = { openai: boolean; deepgram: boolean; anthropic: boolean; elevenlabs: boolean };
	let keyStatus = $state<ApiKeyStatus | null>(null);
	let voiceSettings = $state<UserVoiceSettings>({
		voice_provider: 'elevenlabs',
		voice_command_language: 'en',
		elevenlabs_voice_id: 'JBFqnCBsd6RMkjVDRZzb',
		elevenlabs_tts_model: 'eleven_flash_v2_5',
		elevenlabs_stt_model: 'scribe_v2_realtime',
		elevenlabs_tts_speed: 1.0,
		elevenlabs_stability: 0.5,
		elevenlabs_similarity: 0.75,
		elevenlabs_style: 0.0,
		elevenlabs_speaker_boost: true,
		elevenlabs_agent_id: null
	});
	let keyStatusLoading = $state(true);

	const missingRequiredKeys = $derived(
		keyStatus !== null &&
		(voiceSettings.voice_provider === 'openai_deepgram'
			? (!keyStatus.openai || !keyStatus.deepgram)
			: !keyStatus.elevenlabs)
	);

	// The prepare step already fetched the due queue: an empty card list (with no cram
	// override active) means there is genuinely nothing to review right now.
	const nothingDue = $derived(
		reviewPrepared &&
		prefetchedCards !== null &&
		(prefetchedCards.cards?.length ?? 0) === 0 &&
		!cramMode
	);

	// Session progress: total captured from the first counts emit of the session,
	// remaining updates on every card change.
	let sessionTotal = $state(0);
	const remainingCount = $derived(counts.new + counts.learning + counts.review);
	const progress = $derived(
		sessionTotal > 0 ? Math.min(1, Math.max(0, 1 - remainingCount / sessionTotal)) : 0
	);

	// Live STT transcript caption: interim results render dimmed, finals solid, then fade.
	let transcriptText = $state('');
	let transcriptFinal = $state(false);
	let transcriptTimer: ReturnType<typeof setTimeout> | null = null;

	function clearTranscript() {
		if (transcriptTimer) clearTimeout(transcriptTimer);
		transcriptTimer = null;
		transcriptText = '';
		transcriptFinal = false;
	}

	const cardsPerMinute = $derived(
		stats && stats.durationMs > 0
			? (stats.cardsReviewed / (stats.durationMs / 60000)).toFixed(1)
			: '0'
	);

	const engine = createReviewEngine();
	function showReviewError(message: string) {
		errorMsg = message;
		if (errorTimer) clearTimeout(errorTimer);
		errorTimer = setTimeout(() => { errorMsg = ''; }, 15000);
	}
	function dismissReviewError() {
		if (errorTimer) clearTimeout(errorTimer);
		errorTimer = null;
		errorMsg = '';
	}

	function openTutor() {
		if (!agentEnabled) {
			showReviewError($t('agent.errors.noAgent'));
			return;
		}
		if (micOn) {
			tutorPausedReviewMic = true;
			engine.toggleMic();
		}
		agentChatOpen = true;
	}

	function requestTutor() {
		engine.executeCommand(phase === 'question' ? 'hint' : 'explain');
	}

	function closeTutor() {
		agentChatOpen = false;
		if (tutorPausedReviewMic && !micOn) engine.toggleMic();
		tutorPausedReviewMic = false;
	}

	function clearCountdown() {
		if (countdownInterval) {
			clearInterval(countdownInterval);
			countdownInterval = null;
		}
		learningCountdown = 0;
	}

	// ===== Mic level meter =====
	// While the STT client is listening we tap its MediaStream with an AnalyserNode and
	// drive a small 4-bar equalizer. If the stream or Web Audio is unavailable (or the
	// user prefers reduced motion) the bars stay in a CSS-driven fallback state.
	const MIC_BAR_REST = 0.25;
	let meterLive = $state(false);
	let micLevels = $state<number[]>([MIC_BAR_REST, MIC_BAR_REST, MIC_BAR_REST, MIC_BAR_REST]);
	let meterCtx: AudioContext | null = null;
	let meterAnalyser: AnalyserNode | null = null;
	let meterSource: MediaStreamAudioSourceNode | null = null;
	let meterRaf = 0;

	function stopMicMeter() {
		if (meterRaf) cancelAnimationFrame(meterRaf);
		meterRaf = 0;
		try { meterSource?.disconnect(); } catch { /* already disconnected */ }
		meterSource = null;
		meterAnalyser = null;
		meterCtx?.close().catch(() => {});
		meterCtx = null;
		meterLive = false;
		micLevels = [MIC_BAR_REST, MIC_BAR_REST, MIC_BAR_REST, MIC_BAR_REST];
	}

	function startMicMeter() {
		if (meterCtx) return;
		if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
		try {
			const stream = engine.getMicStream();
			const AudioContextCtor =
				window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
			if (!stream || !AudioContextCtor) return; // fall back to the CSS equalizer
			meterCtx = new AudioContextCtor();
			if (meterCtx.state === 'suspended') void meterCtx.resume().catch(() => {});
			meterAnalyser = meterCtx.createAnalyser();
			meterAnalyser.fftSize = 128;
			meterAnalyser.smoothingTimeConstant = 0.6;
			meterSource = meterCtx.createMediaStreamSource(stream);
			meterSource.connect(meterAnalyser);
			const bins = new Uint8Array(meterAnalyser.frequencyBinCount);
			// Four rough frequency bands, low → high; speech energy sits mostly in the lower two.
			const bands: Array<[number, number]> = [[0, 4], [4, 12], [12, 28], [28, 64]];
			const tick = () => {
				if (!meterAnalyser) return;
				meterAnalyser.getByteFrequencyData(bins);
				micLevels = bands.map(([from, to]) => {
					let sum = 0;
					for (let i = from; i < to; i++) sum += bins[i];
					const avg = sum / (to - from) / 255;
					return Math.min(1, MIC_BAR_REST + avg * 1.6);
				});
				meterRaf = requestAnimationFrame(tick);
			};
			meterLive = true;
			meterRaf = requestAnimationFrame(tick);
		} catch {
			stopMicMeter();
		}
	}

	$effect(() => {
		if (started && !sessionEnded && status === 'listening' && micOn) {
			startMicMeter();
			return () => stopMicMeter();
		}
	});

	engine.onEvent((event: ReviewEvent) => {
		switch (event.type) {
			case 'phase_change':
				phase = event.phase;
				break;
			case 'card_change':
				clearCountdown();
				cardsReviewed = event.index + 1;
				frontText = event.front;
				backText = event.back;
				frontHtml = event.frontHtml;
				backHtml = event.backHtml;
				cardState = event.cardState;
				intervals = event.intervals;
				agentCardId = event.cardId ?? '';
				status = 'idle';
				break;
			case 'tts_loading':
				status = 'loading';
				break;
			case 'speaking':
				status = 'speaking';
				break;
			case 'listening':
				status = 'listening';
				break;
			case 'idle':
				status = 'idle';
				break;
			case 'transcript': {
				transcriptText = event.text;
				transcriptFinal = event.isFinal;
				if (transcriptTimer) clearTimeout(transcriptTimer);
				transcriptTimer = null;
				if (event.isFinal) {
					transcriptTimer = setTimeout(() => {
						transcriptTimer = null;
						transcriptText = '';
						transcriptFinal = false;
					}, 2000);
				}
				break;
			}
			case 'command':
				if (event.command === 'hint' || event.command === 'explain') openTutor();
				if (['again', 'hard', 'good', 'easy'].includes(event.command)) {
					highlightRating = event.command;
					if (highlightTimer) clearTimeout(highlightTimer);
					highlightTimer = setTimeout(() => { highlightRating = ''; }, 400);
				}
				break;
			case 'session_end':
				clearCountdown();
				clearTranscript();
				sessionEnded = true;
				stats = event.stats;
				status = 'idle';
				document.body.classList.remove('review-active');
				break;
			case 'error':
				showReviewError(event.message);
				break;
			case 'deck_info':
				deckName = event.name;
				break;
			case 'undo_available':
				undoAvailable = event.available;
				break;
			case 'mic_change':
				micOn = event.micOn;
				break;
			case 'audio_change':
				audioOn = event.audioOn;
				break;
			case 'counts': {
				counts = event.counts;
				const total = event.counts.new + event.counts.learning + event.counts.review;
				if (total > sessionTotal) sessionTotal = total;
				break;
			}
			case 'learning_due': {
				status = 'waiting';
				clearCountdown();
				learningCountdown = Math.ceil(event.waitMs / 1000);
				countdownInterval = setInterval(() => {
					learningCountdown--;
					if (learningCountdown <= 0) {
						clearCountdown();
					}
				}, 1000);
				break;
			}
			case 'card_suspended': {
				suspendedNotice = $t('review.cardSuspended');
				if (suspendedTimer) clearTimeout(suspendedTimer);
				suspendedTimer = setTimeout(() => { suspendedNotice = ''; }, 3000);
				break;
			}
		}
	});

	async function startReview() {
		// Bless the shared media element inside this gesture so the first card can be fetched
		// after the click and still play on iOS — this is why Start no longer waits for a TTS
		// round trip before it enables.
		unlockAudioForGesture();
		started = true;
		errorMsg = '';
		document.body.classList.add('review-active');
		// Warm the tutor's WebRTC bundle now (after deck-open paint, during the session) so it's
		// parsed by the time the user opens the tutor — without weighing down deck open itself.
		if (agentEnabled) void import('@elevenlabs/client').catch(() => {});
		const options: StartOptions = {};
		if (tagFilter.trim()) options.tags = tagFilter.trim();
		if (cramMode) {
			options.mode = 'cram';
			if (cramState) options.cramState = cramState;
		}
		// Use prefetched cards if no filters/cram mode changed the query
		if (prefetchedCards && !options.tags && !options.mode) {
			options.prefetchedCards = prefetchedCards;
		}
		options.sttLanguage = sttLanguageForVoiceCommandLanguage(voiceSettings.voice_command_language);
		options.voiceProvider = voiceSettings.voice_provider;
		options.prepareAudioAhead = getPrepareAudioAhead();
		try {
			await engine.start(deckId!, options);
		} catch {
			started = false;
			document.body.classList.remove('review-active');
		}
	}

	/**
	 * "Review again" from the summary: reset all per-session UI state and start a fresh
	 * session. The stale prefetched card set is dropped so the engine refetches what is
	 * due now (cards just rated should not come straight back).
	 */
	async function restartSession() {
		sessionEnded = false;
		stats = null;
		started = false;
		cardsReviewed = 0;
		sessionTotal = 0;
		counts = { new: 0, learning: 0, review: 0 };
		phase = 'question';
		status = 'idle';
		frontText = '';
		backText = '';
		frontHtml = '';
		backHtml = '';
		cardState = null;
		intervals = { again: '', hard: '', good: '', easy: '' };
		undoAvailable = false;
		highlightRating = '';
		suspendedNotice = '';
		clearCountdown();
		clearTranscript();
		prefetchedCards = null;
		await startReview();
	}

	function formatDuration(ms: number): string {
		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${minutes}m ${secs}s`;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!started || sessionEnded) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

		// Toggle the shortcuts overlay with `?` at any time during an active session
		if (e.key === '?') {
			shortcutsOpen = !shortcutsOpen;
			return;
		}

		// Close the overlay with Escape when it is open
		if (shortcutsOpen && e.key === 'Escape') {
			shortcutsOpen = false;
			return;
		}

		// Disable action shortcuts while STT is actively listening to avoid conflicts
		if (status === 'listening') return;

		switch (e.key) {
			case ' ':
			case 'Enter':
				e.preventDefault();
				if (phase === 'question') engine.executeCommand('answer');
				break;
			case '1':
				if (phase === 'rating') engine.executeCommand('again');
				break;
			case '2':
				if (phase === 'rating') engine.executeCommand('hard');
				break;
			case '3':
				if (phase === 'rating') engine.executeCommand('good');
				break;
			case '4':
				if (phase === 'rating') engine.executeCommand('easy');
				break;
			case 'e':
				if (phase === 'rating') requestTutor();
				break;
			case 'h':
				if (phase === 'question') requestTutor();
				break;
			case 'r':
				engine.executeCommand('repeat');
				break;
			case 's':
				engine.executeCommand('suspend');
				break;
			case 'z':
				if (undoAvailable) engine.undo();
				break;
			case 'Escape':
				engine.executeCommand('stop');
				break;
		}
	}

	// Prefetch cards + deck name on mount so engine.start() is instant
	$effect(() => {
		// Check API key status first
		Promise.all([
			fetch('/api/settings/api-keys').then((r) => r.ok ? r.json() : null),
			fetch(`/api/settings/voice?locale=${encodeURIComponent($locale)}`).then((r) => r.ok ? r.json() : null)
		])
			.then(([keys, voice]) => {
				if (keys) keyStatus = keys as ApiKeyStatus;
				if (voice) {
					const settings = (voice as { settings: UserVoiceSettings }).settings;
					voiceSettings = settings;
					// The tutor button only appears when the user has configured an agent.
					// Avoids surfacing a "Ask" button that always errors with "no_agent".
					agentEnabled = !!settings.elevenlabs_agent_id;
				}
			})
			.catch(() => {})
			.finally(() => { keyStatusLoading = false; });

		fetch(`/api/decks/${deckId}`)
			.then((r) => r.json())
			.then((data) => { deckName = (data as { deck: { name: string } }).deck.name; })
			.catch(() => {});

		// Prefetch the full card set (reused by engine.start to skip duplicate fetch)
		fetch(`/api/cards/next?${new URLSearchParams({ deckId: deckId!, limit: '50' })}`)
			.then((r) => r.ok ? r.json() : null)
			.then((data) => {
				if (!data) { reviewPrepared = true; return; }
				prefetchedCards = data as PrefetchedCards;
				// Enable Start the moment the cards are here — no longer blocked on a TTS round
				// trip. The first card's front is still preloaded in the background so playback is
				// instant when it lands; if the user clicks Start before it does, the
				// gesture-unlocked media element fetches and plays it on the spot (see
				// unlockAudioForGesture).
				reviewPrepared = true;
				if (!getPrepareAudioAhead()) return;
				const cards = (data as PrefetchedCards).cards;
				if (!cards?.length) return;
				try {
					const card = cards[0];
					const rendered = renderCard(
						card.fields as string,
						card.card_type as string,
						(card.ordinal as number) ?? 0,
						(card.front_template as string | null) ?? null,
						(card.back_template as string | null) ?? null,
						clientCardSanitizer
					);
					if (rendered.front) void preloadTTS(rendered.front, undefined, undefined, deckId);
				} catch { /* ignore parse errors */ }
			})
			.catch(() => { reviewPrepared = true; });
	});

	onDestroy(() => {
		clearCountdown();
		clearTranscript();
		if (suspendedTimer) clearTimeout(suspendedTimer);
		if (errorTimer) clearTimeout(errorTimer);
		if (highlightTimer) clearTimeout(highlightTimer);
		document.body.classList.remove('review-active');
		engine.destroy();
	});
</script>

<svelte:window onkeydown={handleKeydown} />

{#if !keyStatusLoading && missingRequiredKeys}
	<div class="review-container">
		<div class="missing-keys-banner">
			<div class="missing-keys-icon">
				<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.5" fill="currentColor" stroke="none"/></svg>
			</div>
			<h2>{$t('review.missingKeys')}</h2>
			<p>{$t('review.missingKeysDetail')}</p>
			<a href="/settings" class="settings-btn">{$t('review.goToSettings')}</a>
		</div>
	</div>
{:else if !started}
	<div class="review-container">
		<div class="start-screen">
			<div class="start-header">
				<h1>{$t('review.readyTitle')}</h1>
				{#if deckName}
					<p class="deck-name">{deckName}</p>
				{:else}
					<div class="deck-name-skeleton"></div>
				{/if}
			</div>
			{#if !nothingDue}
				<p class="start-hint">{$t('review.startHint')}</p>
			{/if}
			{#if errorMsg}
				<p class="start-error">{errorMsg}</p>
			{/if}

			{#if nothingDue}
				<div class="nothing-due" role="status">
					<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
					<p class="nothing-due-title">{$t('review.nothingDueTitle')}</p>
					<p class="nothing-due-hint">{$t('review.nothingDueHint')}</p>
					<a href="/" class="btn-secondary">{$t('session.backToDashboard')}</a>
				</div>
			{:else}
				<button class="start-btn" onclick={startReview} disabled={!reviewPrepared} aria-busy={!reviewPrepared}>{!reviewPrepared ? $t('common.loading') : cramMode ? $t('review.startCram') : $t('review.startReview')}</button>
			{/if}

			<div class="review-options">
				<label class="option-label">
					{$t('review.filterTags')}
					<input type="text" class="option-input" bind:value={tagFilter} placeholder={$t('review.tagPlaceholder')} />
				</label>

				<label class="option-checkbox">
					<input type="checkbox" bind:checked={cramMode} />
					{$t('review.cramMode')} <span class="option-hint">{$t('review.cramHint')}</span>
				</label>

				{#if cramMode}
					<label class="option-label">
						{$t('review.cramStateFilter')}
						<select class="option-input" bind:value={cramState}>
							<option value="">{$t('review.allStates')}</option>
							<option value="new">{$t('review.newOnly')}</option>
							<option value="learning">{$t('review.learningOnly')}</option>
							<option value="review">{$t('review.reviewOnly')}</option>
						</select>
					</label>
				{/if}
			</div>

			<button class="help-toggle" onclick={() => helpOpen = !helpOpen}>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
				<span class="help-toggle-text">{helpOpen ? $t('review.hideHelp') : $t('review.showHelp')}</span>
				<svg class="help-chevron" class:open={helpOpen} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
			</button>
			{#if helpOpen}
				<div class="commands-help">
					<ul>
						<li><strong>{$t('help.answer')}</strong> — {$t('help.answerDesc')} <kbd>Space</kbd></li>
						<li><strong>{$t('help.hint')}</strong> — {$t('help.hintDesc')} <kbd>H</kbd></li>
						<li><strong>{$t('help.ratings')}</strong> — {$t('help.ratingsDesc')} <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></li>
						<li><strong>{$t('help.repeat')}</strong> — {$t('help.repeatDesc')} <kbd>R</kbd></li>
						<li><strong>{$t('help.explain')}</strong> — {$t('help.explainDesc')} <kbd>E</kbd></li>
						<li><strong>{$t('help.stop')}</strong> — {$t('help.stopDesc')} <kbd>Esc</kbd></li>
					</ul>
				</div>
			{/if}
		</div>
	</div>
{:else if sessionEnded && stats}
	<div class="review-container">
		<div class="summary">
			<h1>{$t('session.completeTitle')}</h1>
			{#if deckName}
				<p class="summary-deck">{deckName}</p>
			{/if}
			<div class="stat-grid">
				<div class="stat">
					<span class="stat-value">{stats.cardsReviewed}</span>
					<span class="stat-label">{$t('session.cardsReviewed')}</span>
				</div>
				<div class="stat">
					<span class="stat-value">{formatDuration(stats.durationMs)}</span>
					<span class="stat-label">{$t('session.duration')}</span>
				</div>
				<div class="stat">
					<span class="stat-value">{cardsPerMinute}</span>
					<span class="stat-label">{$t('session.cardsPerMinute')}</span>
				</div>
			</div>
			<div class="ratings-summary">
				<span class="rating-chip again">{$t('rating.again')} · {stats.ratings.again}</span>
				<span class="rating-chip hard">{$t('rating.hard')} · {stats.ratings.hard}</span>
				<span class="rating-chip good">{$t('rating.good')} · {stats.ratings.good}</span>
				<span class="rating-chip easy">{$t('rating.easy')} · {stats.ratings.easy}</span>
			</div>
			<div class="summary-actions">
				<a href="/" class="btn-secondary">{$t('session.backToDashboard')}</a>
				<button class="btn-primary" onclick={restartSession}>{$t('session.reviewAgain')}</button>
			</div>
		</div>
	</div>
{:else}
	<!-- Active review: AnkiWeb-style fullscreen layout -->

	<!-- Session progress: thin bar pinned to the very top -->
	<div
		class="session-progress"
		role="progressbar"
		aria-label={$t('review.sessionProgress')}
		aria-valuemin="0"
		aria-valuemax="100"
		aria-valuenow={Math.round(progress * 100)}
	>
		<div class="session-progress-fill" style="width: {progress * 100}%"></div>
	</div>

	<!-- Toast errors at top -->
	{#if errorMsg}
		<div class="toast-error" role="alert">
			<span class="toast-error-text">{errorMsg}</span>
			<button class="toast-dismiss" onclick={dismissReviewError} aria-label={$t('common.dismiss')} title={$t('common.dismiss')}>✕</button>
		</div>
	{/if}

	{#if suspendedNotice}
		<div class="toast-notice">{suspendedNotice}</div>
	{/if}

	<!-- Top bar -->
	<div class="top-bar">
		<div class="top-left">
			<button class="toolbar-btn" class:off={!audioOn} onclick={() => engine.toggleAudio()} aria-label={audioOn ? $t('review.muteAudio') : $t('review.unmuteAudio')} title={audioOn ? $t('review.muteAudio') : $t('review.unmuteAudio')}>
				{#if audioOn}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
				{:else}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
				{/if}
			</button>
			<button class="toolbar-btn" class:off={!micOn} onclick={() => engine.toggleMic()} aria-label={micOn ? $t('review.muteMic') : $t('review.unmuteMic')} title={micOn ? $t('review.muteMic') : $t('review.unmuteMic')}>
				{#if micOn}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
				{:else}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.5-.36 2.18"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
				{/if}
			</button>
			<button class="toolbar-btn toolbar-btn--tutor" class:off={!agentEnabled} onclick={requestTutor} title="{$t('agent.openTutor')} (H/E)" aria-label={$t('agent.openTutor')}>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="9" y1="10" x2="15" y2="10"/></svg>
				<span>{$t('agent.openTutor')}</span>
			</button>
			<button class="toolbar-btn" onclick={() => shortcutsOpen = !shortcutsOpen} title="{$t('help.keyHelp')} (?)" aria-label={$t('help.keyboardTitle')} aria-pressed={shortcutsOpen}>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none"/></svg>
			</button>
			{#if status === 'loading' || status === 'speaking'}
				<span class="voice-dot" class:loading={status === 'loading'} class:speaking={status === 'speaking'}></span>
			{:else if status === 'listening'}
				<span class="mic-meter" class:live={meterLive} aria-hidden="true">
					{#each micLevels as level, i (i)}
						<span class="mic-bar" style:transform={meterLive ? `scaleY(${level})` : undefined}></span>
					{/each}
				</span>
			{/if}
		</div>
		<div class="top-right">
			<div class="counts">
				<span class="count count-new" class:active={cardState === 'new'}>{counts.new}</span>
				<span class="count-sep">+</span>
				<span class="count count-learning" class:active={cardState === 'learning'}>{counts.learning}</span>
				<span class="count-sep">+</span>
				<span class="count count-review" class:active={cardState === 'review'}>{counts.review}</span>
			</div>
			<button class="toolbar-btn stop" onclick={() => engine.executeCommand('stop')} title="{$t('review.stop')} (Esc)" aria-label={$t('review.stop')}>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
			</button>
		</div>
	</div>

	<!-- Card content area -->
	<div class="card-area">
		{#key cardsReviewed}
			<div class="card-content" class:held={status === 'waiting'} role="region" aria-label={$t('review.cardRegion')}>
				<div class="question-text">{@html frontHtml}</div>
				{#if phase === 'rating'}
					<hr class="card-divider" />
					<div class="answer-text">{@html backHtml}</div>
				{/if}
			</div>
		{/key}
		{#if status === 'waiting'}
			<!-- Learning hold: the rated card stays visible (dimmed) under a countdown pill -->
			<div class="hold-pill" role="status">{$t('review.waitingCard', { seconds: learningCountdown })}</div>
		{/if}
	</div>

	<!-- Live STT transcript caption -->
	{#if transcriptText}
		<div
			class="transcript-pill"
			class:interim={!transcriptFinal}
			role="status"
			aria-label={$t('review.transcriptLabel')}
			transition:fade={{ duration: 180 }}
		>{transcriptText}</div>
	{/if}

	<!-- Fixed bottom actions -->
	<div class="bottom-bar">
		{#if undoAvailable}
			<button class="undo-link" onclick={() => engine.undo()}>{$t('review.undo')} <kbd>Z</kbd></button>
		{/if}
		{#if phase === 'question' && status !== 'waiting'}
			<div class="bottom-actions">
				<button class="show-answer-btn" onclick={() => engine.executeCommand('answer')}>{$t('review.showAnswer')}</button>
			</div>
		{:else if phase === 'rating' && status !== 'waiting'}
			<div class="interval-labels">
				<span class="interval">{intervals.again}</span>
				<span class="interval">{intervals.hard}</span>
				<span class="interval">{intervals.good}</span>
				<span class="interval">{intervals.easy}</span>
			</div>
			<div class="rating-buttons">
				<button class="rate-btn again" class:voice-picked={highlightRating === 'again'} onclick={() => engine.executeCommand('again')}>{$t('rating.again')}</button>
				<button class="rate-btn hard" class:voice-picked={highlightRating === 'hard'} onclick={() => engine.executeCommand('hard')}>{$t('rating.hard')}</button>
				<button class="rate-btn good" class:voice-picked={highlightRating === 'good'} onclick={() => engine.executeCommand('good')}>{$t('rating.good')}</button>
				<button class="rate-btn easy" class:voice-picked={highlightRating === 'easy'} onclick={() => engine.executeCommand('easy')}>{$t('rating.easy')}</button>
			</div>
		{/if}
	</div>

	<!-- Keyboard shortcuts overlay -->
	{#if shortcutsOpen}
		<button class="shortcuts-backdrop" onclick={() => shortcutsOpen = false} aria-label={$t('help.closeOverlay')}></button>
		<div class="shortcuts-wrap">
			<div
				class="shortcuts-overlay"
				role="dialog"
				aria-modal="true"
				aria-label={$t('help.keyboardTitle')}
				tabindex="-1"
				onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); shortcutsOpen = false; } }}
				use:focusTrap
			>
				<div class="shortcuts-header">
					<span class="shortcuts-title">{$t('help.keyboardTitle')}</span>
					<button class="shortcuts-close" onclick={() => shortcutsOpen = false} aria-label={$t('help.closeOverlay')}>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
					</button>
				</div>
				<table class="shortcuts-table">
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
				<div class="shortcuts-section-title">{$t('help.voiceTitle')}</div>
				<ul class="shortcuts-voice">
					<li><strong>{$t('help.answer')}</strong> — {$t('help.answerDesc')}</li>
					<li><strong>{$t('help.ratings')}</strong> — {$t('help.ratingsDesc')}</li>
					<li><strong>{$t('help.repeat')}</strong> — {$t('help.repeatDesc')}</li>
					<li><strong>{$t('help.explain')}</strong> — {$t('help.explainDesc')}</li>
					<li><strong>{$t('help.hint')}</strong> — {$t('help.hintDesc')}</li>
					<li><strong>{$t('help.stop')}</strong> — {$t('help.stopDesc')}</li>
				</ul>
			</div>
		</div>
	{/if}
{/if}

<AgentChat
	open={agentChatOpen}
	cardId={agentCardId}
	answerRevealed={phase === 'rating'}
	locale={$locale === 'de' ? 'de' : 'en'}
	onclose={closeTutor}
/>

<style>
	/* ========== Missing Keys Banner ========== */
	.missing-keys-banner {
		text-align: center;
		padding: 3rem 2rem;
		max-width: 480px;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
	}

	.missing-keys-icon {
		color: var(--text-muted);
		opacity: 0.85;
	}

	.missing-keys-banner h2 {
		font-size: 1.25rem;
		font-weight: 600;
		color: var(--text);
		margin: 0;
	}

	.missing-keys-banner p {
		font-size: 0.95rem;
		color: var(--text-muted);
		line-height: 1.6;
		margin: 0;
		max-width: 360px;
	}

	.settings-btn {
		display: inline-block;
		margin-top: 0.5rem;
		padding: 0.75rem 1.75rem;
		background: var(--primary);
		color: var(--text-on-primary);
		border: none;
		border-radius: var(--r-md);
		font-size: 1rem;
		font-weight: 600;
		text-decoration: none;
		transition: background var(--t-fast) var(--ease);
	}

	.settings-btn:hover {
		background: var(--primary-hover);
	}

	/* ========== Start Screen ========== */
	.review-container {
		min-height: 80dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.start-screen {
		text-align: center;
		padding-top: 3rem;
		max-width: 480px;
		width: 100%;
		padding-left: 1.5rem;
		padding-right: 1.5rem;
		animation: fade-in var(--t-med) var(--ease) both;
	}

	.start-header {
		margin-bottom: 0.5rem;
	}

	.start-header h1 {
		margin-bottom: 0.35rem;
	}

	.deck-name {
		font-size: 1.1rem;
		color: var(--text-muted);
		font-weight: 500;
		margin: 0;
		animation: fade-in var(--t-med) var(--ease) both;
	}

	.deck-name-skeleton {
		height: 1.1rem;
		width: 180px;
		margin: 0 auto;
		border-radius: var(--r-sm);
		background: linear-gradient(90deg, var(--border-muted) 25%, var(--border) 50%, var(--border-muted) 75%);
		background-size: 200% 100%;
		animation: shimmer 1.2s ease-in-out infinite;
	}

	.start-hint {
		color: var(--text-subtle);
		font-size: 0.95rem;
		margin: 0.75rem 0 0;
	}

	.start-error {
		color: var(--danger-soft);
		background: var(--danger-tint);
		border: 1px solid var(--danger-border);
		border-radius: var(--r-md);
		padding: 0.55rem 0.75rem;
		font-size: 0.85rem;
		font-weight: 600;
		margin: 1rem auto 0;
		max-width: 360px;
	}

	.start-btn {
		padding: 1rem 2.5rem;
		font-size: 1.15rem;
		font-weight: 600;
		font-family: inherit;
		background: var(--primary);
		color: var(--text-on-primary);
		border: none;
		border-radius: var(--r-lg);
		cursor: pointer;
		touch-action: manipulation;
		margin: 1.5rem 0;
		transition: background var(--t-fast) var(--ease), transform 80ms var(--ease);
	}

	.start-btn:hover {
		background: var(--primary-hover);
	}

	.start-btn:active {
		transform: scale(0.97);
	}

	.start-btn:disabled {
		opacity: 0.55;
		cursor: wait;
		transform: none;
	}

	.nothing-due {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
		margin: 1.5rem auto 0;
		padding: 1.5rem;
		max-width: 360px;
		background: var(--surface);
		border: 1px solid var(--border-muted);
		border-radius: var(--r-lg);
		animation: fade-in var(--t-med) var(--ease) both;
	}

	.nothing-due svg {
		color: var(--success);
	}

	.nothing-due-title {
		font-size: 1.05rem;
		font-weight: 700;
		color: var(--text);
		margin: 0;
	}

	.nothing-due-hint {
		font-size: 0.9rem;
		color: var(--text-muted);
		line-height: 1.5;
		margin: 0 0 0.5rem;
	}

	.review-options {
		max-width: 320px;
		margin: 1.5rem auto;
		text-align: left;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.option-label {
		display: block;
		font-size: 0.85rem;
		color: var(--text-muted);
		font-weight: 600;
	}

	.option-input {
		display: block;
		width: 100%;
		margin-top: 0.3rem;
		padding: 0.5rem 0.6rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--r-sm);
		color: var(--text);
		font-size: 0.9rem;
		font-family: inherit;
	}

	.option-input:focus {
		outline: none;
		border-color: var(--border-strong);
	}

	.option-checkbox {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9rem;
		color: var(--text);
		cursor: pointer;
	}

	.option-hint {
		color: var(--text-subtle);
		font-size: 0.8rem;
	}

	/* Multi-line pill: the German label wraps to 2–3 lines on narrow screens */
	.help-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-wrap: wrap;
		gap: 0.45rem;
		max-width: 100%;
		background: transparent;
		border: 1px solid var(--border);
		color: var(--text-muted);
		cursor: pointer;
		font-size: 0.875rem;
		font-family: inherit;
		font-weight: 500;
		line-height: 1.35;
		padding: 0.5rem 1rem;
		border-radius: var(--r-pill);
		margin-top: 1rem;
		transition: border-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
	}

	.help-toggle-text {
		white-space: normal;
		overflow-wrap: break-word;
		min-width: 0;
	}

	.help-toggle:hover {
		border-color: var(--border-strong);
		color: var(--text);
		background: var(--surface);
	}

	.help-chevron {
		transition: transform var(--t-med) var(--ease);
		opacity: 0.7;
	}

	.help-chevron.open {
		transform: rotate(180deg);
	}

	.commands-help {
		text-align: left;
		max-width: 400px;
		margin: 0.75rem auto 0;
		color: var(--text-muted);
		font-size: 0.9rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--r-md);
		padding: 0.75rem 1rem;
	}

	.commands-help ul {
		padding-left: 0;
		list-style: none;
		margin: 0;
	}

	.commands-help li {
		margin-bottom: 0.4rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
	}

	.commands-help li:last-child {
		margin-bottom: 0;
	}

	/* ========== Session Complete ========== */
	.summary {
		text-align: center;
		padding: 3rem 1.5rem 2rem;
		max-width: 560px;
		width: 100%;
		animation: fade-in var(--t-med) var(--ease) both;
	}

	.summary h1 {
		margin: 0 0 0.35rem;
	}

	.summary-deck {
		font-size: 1.05rem;
		color: var(--text-muted);
		font-weight: 500;
		margin: 0;
	}

	.stat-grid {
		display: flex;
		gap: 2.5rem;
		justify-content: center;
		flex-wrap: wrap;
		margin: 2.25rem 0 1.75rem;
	}

	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.15rem;
	}

	.stat-value {
		font-size: 2.4rem;
		font-weight: 700;
		letter-spacing: -0.02em;
	}

	.stat-label {
		color: var(--text-subtle);
		font-size: 0.8rem;
		font-weight: 600;
	}

	.ratings-summary {
		display: flex;
		gap: 0.5rem;
		justify-content: center;
		flex-wrap: wrap;
		margin-bottom: 2.5rem;
	}

	.rating-chip {
		padding: 0.4rem 0.9rem;
		border-radius: var(--r-pill);
		border: 1px solid transparent;
		font-size: 0.85rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.rating-chip.again {
		background: var(--danger-tint);
		color: var(--danger-soft);
		border-color: var(--danger-border);
	}

	.rating-chip.hard {
		background: var(--warning-tint);
		color: var(--warning);
		border-color: var(--warning-border);
	}

	.rating-chip.good {
		background: var(--success-tint);
		color: var(--success);
		border-color: var(--success-border);
	}

	.rating-chip.easy {
		background: var(--info-tint);
		color: var(--info);
		border-color: var(--info-border);
	}

	.summary-actions {
		display: flex;
		gap: 0.75rem;
		justify-content: center;
		flex-wrap: wrap;
	}

	.summary-actions .btn-primary,
	.summary-actions .btn-secondary {
		padding: 0.7rem 1.6rem;
		font-size: 1rem;
		min-height: 44px;
		text-decoration: none;
	}

	/* ========== Session Progress Bar ========== */
	.session-progress {
		position: fixed;
		top: env(safe-area-inset-top, 0px);
		left: 0;
		right: 0;
		height: 2px;
		z-index: 60;
		pointer-events: none;
	}

	.session-progress-fill {
		height: 100%;
		width: 0;
		background: var(--primary);
		border-radius: 0 1px 1px 0;
		transition: width var(--t-med) var(--ease);
	}

	/* ========== Toast Notifications ========== */
	.toast-error {
		position: fixed;
		top: max(0.75rem, env(safe-area-inset-top));
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 0.6rem;
		max-width: min(90vw, 32rem);
		background: var(--danger-tint);
		color: var(--danger-soft);
		border: 1px solid var(--danger-border);
		padding: 0.5rem 0.6rem 0.5rem 1.2rem;
		border-radius: var(--r-md);
		font-size: 0.85rem;
		font-weight: 600;
		z-index: 100;
		box-shadow: var(--shadow-md);
		-webkit-backdrop-filter: blur(12px);
		backdrop-filter: blur(12px);
		animation: toast-in var(--t-med) var(--ease);
	}

	.toast-dismiss {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
		padding: 0;
		border: none;
		border-radius: var(--r-sm);
		background: transparent;
		color: inherit;
		font-size: 0.8rem;
		line-height: 1;
		cursor: pointer;
		opacity: 0.8;
	}

	.toast-dismiss:hover {
		opacity: 1;
		background: rgba(255, 255, 255, 0.12);
	}

	.toast-notice {
		position: fixed;
		top: max(0.75rem, env(safe-area-inset-top));
		left: 50%;
		transform: translateX(-50%);
		background: var(--warning-tint);
		color: var(--warning);
		border: 1px solid var(--warning-border);
		padding: 0.5rem 1.2rem;
		border-radius: var(--r-md);
		font-size: 0.85rem;
		font-weight: 600;
		z-index: 100;
		box-shadow: var(--shadow-md);
		-webkit-backdrop-filter: blur(12px);
		backdrop-filter: blur(12px);
		animation: toast-in var(--t-med) var(--ease);
	}

	/* Toasts center themselves with translateX(-50%), so they need their own entrance
	   keyframes — the global slide-down would drop that offset mid-animation. */
	@keyframes toast-in {
		from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
		to { opacity: 1; transform: translateX(-50%) translateY(0); }
	}

	/* ========== Top Bar ========== */
	.top-bar {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 48px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		padding: env(safe-area-inset-top) 0.75rem 0;
		z-index: 50;
		background: var(--bg);
	}

	.top-left {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		min-width: 0;
	}

	.top-right {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
	}

	.counts {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		min-width: 0;
		font-size: 0.9rem;
		font-weight: 600;
	}

	.toolbar-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 44px;
		height: 44px;
		border-radius: var(--r-sm);
		border: none;
		background: transparent;
		color: var(--text-subtle);
		cursor: pointer;
		touch-action: manipulation;
		transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
	}

	.toolbar-btn:hover {
		background: rgba(255, 255, 255, 0.08);
		color: var(--text);
	}

	.toolbar-btn.off {
		color: var(--danger-soft);
	}

	.toolbar-btn.stop:hover {
		color: var(--danger-soft);
	}

	.toolbar-btn--tutor {
		width: auto;
		padding: 0 0.65rem;
		gap: 0.35rem;
		font-size: 0.78rem;
		font-weight: 600;
		font-family: inherit;
		color: var(--accent);
	}

	@media (max-width: 380px) {
		.toolbar-btn--tutor {
			width: 44px;
			padding: 0;
		}

		.toolbar-btn--tutor span {
			display: none;
		}
	}

	.voice-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		margin-left: 0.3rem;
		flex-shrink: 0;
	}

	.voice-dot.loading {
		background: var(--warning);
		animation: pulse-fade 0.8s ease-in-out infinite;
	}

	.voice-dot.speaking {
		background: var(--warning);
		animation: pulse-dot 1s ease-in-out infinite;
	}

	@keyframes pulse-dot {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.4; transform: scale(1.3); }
	}

	@keyframes pulse-fade {
		0%, 100% { opacity: 0.3; transform: scale(0.8); }
		50% { opacity: 1; transform: scale(1.2); }
	}

	/* ========== Mic Level Meter ========== */
	.mic-meter {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		height: 16px;
		margin-left: 0.3rem;
		flex-shrink: 0;
	}

	.mic-bar {
		width: 3px;
		height: 14px;
		border-radius: 2px;
		background: var(--success);
		transform: scaleY(0.25);
		transform-origin: center;
		will-change: transform;
	}

	.mic-meter.live .mic-bar {
		transition: transform 60ms linear;
	}

	/* Fallback when the analyser isn't available: a gentle CSS equalizer driven purely
	   by the listening state. Neutralized to static bars under reduced motion. */
	.mic-meter:not(.live) .mic-bar {
		animation: mic-eq 1.1s ease-in-out infinite;
	}

	.mic-meter:not(.live) .mic-bar:nth-child(2) { animation-delay: 0.18s; }
	.mic-meter:not(.live) .mic-bar:nth-child(3) { animation-delay: 0.36s; }
	.mic-meter:not(.live) .mic-bar:nth-child(4) { animation-delay: 0.09s; }

	@keyframes mic-eq {
		0%, 100% { transform: scaleY(0.25); }
		50% { transform: scaleY(0.9); }
	}

	.count-new { color: var(--info); }
	.count-learning { color: var(--warning); }
	.count-review { color: var(--success); }
	.count-sep { color: var(--text-subtle); font-size: 0.75rem; }

	.count.active {
		text-decoration: underline;
		text-underline-offset: 3px;
		font-weight: 600;
	}

	/* ========== Card Area ========== */
	.card-area {
		position: fixed;
		top: calc(48px + env(safe-area-inset-top));
		bottom: 0;
		left: 0;
		right: 0;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: 1.5rem;
		padding-bottom: 140px;
		overflow-y: auto;
	}

	.card-content {
		max-width: 600px;
		width: 100%;
		text-align: center;
		animation: pop var(--t-med) var(--ease);
		transition: opacity var(--t-med) var(--ease);
	}

	.card-content.held {
		opacity: 0.35;
	}

	.hold-pill {
		position: absolute;
		left: 50%;
		top: 38%;
		transform: translate(-50%, -50%);
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		border-radius: var(--r-pill);
		box-shadow: var(--shadow-md);
		color: var(--text-muted);
		font-size: 0.9rem;
		font-weight: 600;
		padding: 0.55rem 1.1rem;
		white-space: nowrap;
		z-index: 1;
		animation: pop var(--t-fast) var(--ease);
	}

	.question-text {
		font-size: 1.4rem;
		margin: 0;
		line-height: 1.5;
	}

	.card-divider {
		border: none;
		border-top: 1px solid var(--border);
		margin: 1.5rem 0;
	}

	.answer-text {
		font-size: 1.2rem;
		margin: 0;
		color: var(--text);
		line-height: 1.5;
	}

	/* Anki HTML card content: support bold, italic, underline, colors, images, etc. */
	.question-text :global(b),
	.question-text :global(strong),
	.answer-text :global(b),
	.answer-text :global(strong) {
		font-weight: 700;
	}

	.question-text :global(i),
	.question-text :global(em),
	.answer-text :global(i),
	.answer-text :global(em) {
		font-style: italic;
	}

	.question-text :global(u),
	.answer-text :global(u) {
		text-decoration: underline;
	}

	.question-text :global(img),
	.answer-text :global(img) {
		max-width: 100%;
		height: auto;
		border-radius: 6px;
		margin: 0.5rem 0;
	}

	.question-text :global(br),
	.answer-text :global(br) {
		display: block;
		content: '';
		margin-top: 0.3rem;
	}

	.question-text :global(ul),
	.question-text :global(ol),
	.answer-text :global(ul),
	.answer-text :global(ol) {
		text-align: left;
		margin: 0.5rem 0;
		padding-left: 1.5rem;
	}

	.question-text :global(.cloze-blank) {
		color: var(--info);
		font-weight: 600;
	}

	.answer-text :global(.cloze-answer) {
		color: var(--success);
		font-weight: 700;
	}

	/* ========== Live Transcript Pill ========== */
	.transcript-pill {
		position: fixed;
		left: 50%;
		transform: translateX(-50%);
		bottom: calc(128px + env(safe-area-inset-bottom, 0px));
		max-width: min(90vw, 480px);
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		border-radius: var(--r-pill);
		box-shadow: var(--shadow-sm);
		color: var(--text);
		font-size: 0.85rem;
		line-height: 1.4;
		padding: 0.4rem 0.9rem;
		text-align: center;
		z-index: 55;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
	}

	.transcript-pill.interim {
		color: var(--text-muted);
		font-style: italic;
	}

	/* ========== Bottom Bar ========== */
	.bottom-bar {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0.5rem 1rem;
		padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
		background: var(--bg);
		border-top: 1px solid var(--border-muted);
		z-index: 50;
	}

	.undo-link {
		background: none;
		border: none;
		color: var(--text-subtle);
		cursor: pointer;
		font-size: 0.75rem;
		font-family: inherit;
		margin-bottom: 0.3rem;
		display: flex;
		align-items: center;
		gap: 0.3rem;
		animation: fade-in var(--t-med) var(--ease);
	}

	.undo-link:hover {
		color: var(--warning);
	}

	.bottom-actions {
		width: 100%;
		max-width: 400px;
	}

	.show-answer-btn {
		width: 100%;
		min-height: 44px;
		padding: 0.9rem;
		font-size: 1.05rem;
		font-weight: 600;
		font-family: inherit;
		background: var(--primary);
		color: var(--text-on-primary);
		border: none;
		border-radius: var(--r-md);
		cursor: pointer;
		touch-action: manipulation;
		transition: background var(--t-fast) var(--ease), transform 80ms var(--ease);
	}

	.show-answer-btn:hover {
		background: var(--primary-hover);
	}

	.show-answer-btn:active {
		transform: scale(0.97);
	}

	.interval-labels {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		width: 100%;
		max-width: 400px;
		min-width: 0;
		text-align: center;
		margin-bottom: 0.2rem;
	}

	.interval {
		font-size: 0.65rem;
		color: var(--text-subtle);
		white-space: nowrap;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		padding: 0 2px;
	}

	.rating-buttons {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.4rem;
		width: 100%;
		max-width: 400px;
	}

	.rate-btn {
		min-width: 0;
		min-height: 44px;
		padding: 0.7rem 0;
		border: 1px solid transparent;
		border-radius: var(--r-md);
		font-size: 0.88rem;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
		touch-action: manipulation;
		transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease), transform 80ms var(--ease);
	}

	.rate-btn:hover {
		border-color: currentColor;
	}

	.rate-btn:active {
		transform: scale(0.97);
	}

	.rate-btn.again {
		background: var(--danger-tint);
		color: var(--danger-soft);
		border-color: var(--danger-border);
	}

	.rate-btn.hard {
		background: var(--warning-tint);
		color: var(--warning);
		border-color: var(--warning-border);
	}

	.rate-btn.good {
		background: var(--success-tint);
		color: var(--success);
		border-color: var(--success-border);
	}

	.rate-btn.easy {
		background: var(--info-tint);
		color: var(--info);
		border-color: var(--info-border);
	}

	.rate-btn.again:hover,
	.rate-btn.hard:hover,
	.rate-btn.good:hover,
	.rate-btn.easy:hover {
		border-color: currentColor;
	}

	.rate-btn.voice-picked {
		box-shadow: 0 0 0 2px currentColor;
	}

	kbd {
		font-size: 0.65rem;
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		background: rgba(255, 255, 255, 0.1);
		border: 1px solid rgba(255, 255, 255, 0.15);
		font-family: inherit;
		color: inherit;
		opacity: 0.7;
	}

	@media (hover: none), (max-width: 640px) {
		kbd { display: none; }
	}

	/* ========== Keyboard Shortcuts Overlay ========== */
	.shortcuts-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.55);
		border: 0;
		padding: 0;
		z-index: 200;
		animation: fade-in var(--t-fast) var(--ease);
	}

	/* Flex-centering wrapper: keeps the dialog centered while the global `pop` keyframes
	   animate its transform (a translate(-50%,-50%) self-center would fight them). */
	.shortcuts-wrap {
		position: fixed;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem 1rem;
		z-index: 201;
		pointer-events: none;
	}

	.shortcuts-overlay {
		pointer-events: auto;
		background: var(--surface-elevated);
		border: 1px solid var(--border);
		border-radius: var(--r-lg);
		box-shadow: var(--shadow-lg);
		padding: 1.25rem 1.5rem;
		/* No min-width: at 320px viewport, 300px > calc(100vw - 2rem) (288px) and pushes the
		   overlay past the right edge. Let the content (table + kbd labels) drive the width. */
		max-width: min(480px, calc(100vw - 2rem));
		max-height: 100%;
		overflow-y: auto;
		animation: pop var(--t-med) var(--ease);
	}

	.shortcuts-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 1rem;
	}

	.shortcuts-title {
		font-size: 1rem;
		font-weight: 700;
		color: var(--text);
	}

	.shortcuts-close {
		background: transparent;
		border: none;
		color: var(--text-subtle);
		cursor: pointer;
		padding: 0.25rem;
		border-radius: var(--r-sm);
		display: flex;
		align-items: center;
		justify-content: center;
		transition: color var(--t-fast) var(--ease);
	}

	.shortcuts-close:hover {
		color: var(--text);
	}

	.shortcuts-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
		margin-bottom: 1.25rem;
	}

	.shortcuts-table td {
		padding: 0.3rem 0;
		vertical-align: middle;
		color: var(--text-muted);
	}

	.shortcuts-table td:first-child {
		white-space: nowrap;
		padding-right: 1.25rem;
		color: var(--text);
	}

	.shortcuts-table tr + tr td {
		border-top: 1px solid var(--border-muted);
		padding-top: 0.35rem;
	}

	.shortcuts-section-title {
		font-size: 0.8rem;
		font-weight: 700;
		color: var(--text-subtle);
		text-transform: uppercase;
		letter-spacing: 0.07em;
		margin-bottom: 0.6rem;
	}

	.shortcuts-voice {
		list-style: none;
		padding: 0;
		margin: 0;
		font-size: 0.875rem;
		color: var(--text-muted);
	}

	.shortcuts-voice li {
		padding: 0.25rem 0;
		border-top: 1px solid var(--border-muted);
	}

	.shortcuts-voice li:first-child {
		border-top: none;
	}

	/* On touch/mobile devices keep the overlay fully usable */
	@media (hover: none), (max-width: 640px) {
		.shortcuts-overlay kbd { display: inline; }
	}
</style>

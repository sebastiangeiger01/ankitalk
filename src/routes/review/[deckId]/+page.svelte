<script lang="ts">
	import { page } from '$app/stores';
	import { onDestroy, onMount } from 'svelte';
	import { createReviewEngine, type ReviewEvent, type SessionStats, type StartOptions, type IntervalLabels, type QueueCounts, type PrefetchedCards } from '$lib/client/review-engine';
	import { preloadTTS } from '$lib/client/audio';
	import { locale, t } from '$lib/i18n';
	import type { ReviewPhase } from '$lib/types';

	const deckId = $derived($page.params.deckId);

	let started = $state(false);
	let phase = $state<ReviewPhase>('question');
	let status = $state<'idle' | 'loading' | 'speaking' | 'listening' | 'explaining' | 'hinting' | 'waiting'>('idle');
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
	let loc = $state('en');
	locale.subscribe((v) => { loc = v; });
	let prefetchedCards = $state<PrefetchedCards | null>(null);
	let highlightRating = $state<string>('');
	let highlightTimer: ReturnType<typeof setTimeout> | null = null;
	let keyStatus = $state<{ openai: boolean; deepgram: boolean; anthropic: boolean } | null>(null);
	let keyStatusLoading = $state(true);

	const missingRequiredKeys = $derived(
		keyStatus !== null && (!keyStatus.openai || !keyStatus.deepgram)
	);

	const engine = createReviewEngine();

	function clearCountdown() {
		if (countdownInterval) {
			clearInterval(countdownInterval);
			countdownInterval = null;
		}
		learningCountdown = 0;
	}

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
			case 'explaining':
				status = 'explaining';
				break;
			case 'hinting':
				status = 'hinting';
				break;
			case 'transcript':
				break;
			case 'command':
				if (['again', 'hard', 'good', 'easy'].includes(event.command)) {
					highlightRating = event.command;
					if (highlightTimer) clearTimeout(highlightTimer);
					highlightTimer = setTimeout(() => { highlightRating = ''; }, 400);
				}
				break;
			case 'session_end':
				clearCountdown();
				sessionEnded = true;
				stats = event.stats;
				status = 'idle';
				document.body.classList.remove('review-active');
				break;
			case 'error':
				errorMsg = event.message;
				if (errorTimer) clearTimeout(errorTimer);
				errorTimer = setTimeout(() => { errorMsg = ''; }, 4000);
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
			case 'counts':
				counts = event.counts;
				break;
			case 'learning_due': {
				status = 'waiting';
				learningCountdown = Math.ceil(event.waitMs / 1000);
				clearCountdown();
				countdownInterval = setInterval(() => {
					learningCountdown--;
					if (learningCountdown <= 0) {
						clearCountdown();
					}
				}, 1000);
				break;
			}
			case 'card_suspended': {
				suspendedNotice = t('review.cardSuspended');
				if (suspendedTimer) clearTimeout(suspendedTimer);
				suspendedTimer = setTimeout(() => { suspendedNotice = ''; }, 3000);
				break;
			}
		}
	});

	async function startReview() {
		started = true;
		errorMsg = '';
		document.body.classList.add('review-active');
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
		// Set STT language to match UI locale for accurate voice command recognition
		options.sttLanguage = loc;
		await engine.start(deckId!, options);
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

		switch (e.key) {
			case ' ':
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
				if (phase === 'rating') engine.executeCommand('explain');
				break;
			case 'h':
				if (phase === 'question') engine.executeCommand('hint');
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
		fetch('/api/settings/api-keys')
			.then((r) => r.ok ? r.json() : null)
			.then((data) => {
				if (data) keyStatus = data as { openai: boolean; deepgram: boolean; anthropic: boolean };
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
				if (!data) return;
				prefetchedCards = data as PrefetchedCards;
				const cards = (data as { cards: { fields: string; card_type: string }[] }).cards;
				if (!cards?.length) return;
				// Preload first 3 fronts + first 2 backs in parallel so early cards play instantly.
				// The TTS endpoint serves from Cloudflare edge cache after the first synthesis.
				const seen = new Set<string>();
				const tryPreload = (rawHtml: string) => {
					const div = document.createElement('div');
					div.innerHTML = rawHtml;
					const plain = (div.textContent ?? '').trim();
					if (plain && !seen.has(plain)) { seen.add(plain); preloadTTS(plain); }
				};
				const limit = Math.min(3, cards.length);
				for (let i = 0; i < limit; i++) {
					try {
						const card = cards[i];
						const fields = JSON.parse(card.fields) as { value: string }[];
						if (!fields.length) continue;
						const firstValue = fields[0]?.value ?? '';
						const isCloze = card.card_type === 'cloze' || /\{\{c\d+::/.test(firstValue);
						if (isCloze) {
							// front: replace answers with hints/blank; back: reveal answers
							tryPreload(firstValue.replace(/\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g, (_m, _a, hint) => hint || 'blank'));
							if (i < 2) tryPreload(firstValue.replace(/\{\{c\d+::(.*?)(?:::(.*?))?\}\}/g, (_m, a) => a));
						} else {
							tryPreload(firstValue);
							if (i < 2 && fields[1]?.value) tryPreload(fields[1].value);
						}
					} catch { /* ignore parse errors */ }
				}
			})
			.catch(() => {});
	});

	onDestroy(() => {
		clearCountdown();
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
			<h2>{t('review.missingKeys')}</h2>
			<p>{t('review.missingKeysDetail')}</p>
			<a href="/settings" class="settings-btn">{t('review.goToSettings')}</a>
		</div>
	</div>
{:else if !started}
	<div class="review-container">
		<div class="start-screen">
			<div class="start-header">
				<h1>{t('review.readyTitle')}</h1>
				{#if deckName}
					<p class="deck-name">{deckName}</p>
				{:else}
					<div class="deck-name-skeleton"></div>
				{/if}
			</div>
			<p class="start-hint">{t('review.startHint')}</p>

			<button class="start-btn" onclick={startReview}>{cramMode ? t('review.startCram') : t('review.startReview')}</button>

			<div class="review-options">
				<label class="option-label">
					{t('review.filterTags')}
					<input type="text" class="option-input" bind:value={tagFilter} placeholder={t('review.tagPlaceholder')} />
				</label>

				<label class="option-checkbox">
					<input type="checkbox" bind:checked={cramMode} />
					{t('review.cramMode')} <span class="option-hint">{t('review.cramHint')}</span>
				</label>

				{#if cramMode}
					<label class="option-label">
						{t('review.cramStateFilter')}
						<select class="option-input" bind:value={cramState}>
							<option value="">{t('review.allStates')}</option>
							<option value="new">{t('review.newOnly')}</option>
							<option value="learning">{t('review.learningOnly')}</option>
							<option value="review">{t('review.reviewOnly')}</option>
						</select>
					</label>
				{/if}
			</div>

			<button class="help-toggle" onclick={() => helpOpen = !helpOpen}>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
				{helpOpen ? t('review.hideHelp') : t('review.showHelp')}
				<svg class="help-chevron" class:open={helpOpen} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
			</button>
			{#if helpOpen}
				<div class="commands-help">
					<ul>
						<li><strong>{t('help.answer')}</strong> — {t('help.answerDesc')} <kbd>Space</kbd></li>
						<li><strong>{t('help.hint')}</strong> — {t('help.hintDesc')} <kbd>H</kbd></li>
						<li><strong>{t('help.ratings')}</strong> — {t('help.ratingsDesc')} <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></li>
						<li><strong>{t('help.repeat')}</strong> — {t('help.repeatDesc')} <kbd>R</kbd></li>
						<li><strong>{t('help.explain')}</strong> — {t('help.explainDesc')} <kbd>E</kbd></li>
						<li><strong>{t('help.stop')}</strong> — {t('help.stopDesc')} <kbd>Esc</kbd></li>
					</ul>
				</div>
			{/if}
		</div>
	</div>
{:else if sessionEnded && stats}
	<div class="review-container">
		<div class="summary">
			<h1>{t('session.completeTitle')}{deckName ? ` — ${deckName}` : ''}</h1>
			<div class="stat-grid">
				<div class="stat">
					<span class="stat-value">{stats.cardsReviewed}</span>
					<span class="stat-label">{t('session.cardsReviewed')}</span>
				</div>
				<div class="stat">
					<span class="stat-value">{formatDuration(stats.durationMs)}</span>
					<span class="stat-label">{t('session.duration')}</span>
				</div>
			</div>
			<div class="ratings-summary">
				<span class="rating again">{t('rating.again')}: {stats.ratings.again}</span>
				<span class="rating hard">{t('rating.hard')}: {stats.ratings.hard}</span>
				<span class="rating good">{t('rating.good')}: {stats.ratings.good}</span>
				<span class="rating easy">{t('rating.easy')}: {stats.ratings.easy}</span>
			</div>
			<a href="/" class="back-link">{t('session.backToDashboard')}</a>
		</div>
	</div>
{:else}
	<!-- Active review: AnkiWeb-style fullscreen layout -->

	<!-- Toast errors at top -->
	{#if errorMsg}
		<div class="toast-error">{errorMsg}</div>
	{/if}

	{#if suspendedNotice}
		<div class="toast-notice">{suspendedNotice}</div>
	{/if}

	<!-- Top bar -->
	<div class="top-bar">
		<div class="top-left">
			<button class="toolbar-btn" class:off={!audioOn} onclick={() => engine.toggleAudio()} aria-label={audioOn ? t('review.muteAudio') : t('review.unmuteAudio')} title={audioOn ? t('review.muteAudio') : t('review.unmuteAudio')}>
				{#if audioOn}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
				{:else}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
				{/if}
			</button>
			<button class="toolbar-btn" class:off={!micOn} onclick={() => engine.toggleMic()} aria-label={micOn ? t('review.muteMic') : t('review.unmuteMic')} title={micOn ? t('review.muteMic') : t('review.unmuteMic')}>
				{#if micOn}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
				{:else}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.5-.36 2.18"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
				{/if}
			</button>
			{#if phase === 'question'}
				<button class="toolbar-btn" onclick={() => engine.executeCommand('hint')} title="{t('review.hint')} (H)" aria-label={t('review.hint')}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z"/></svg>
				</button>
			{:else}
				<button class="toolbar-btn" onclick={() => engine.executeCommand('explain')} title="{t('review.explain')} (E)" aria-label={t('review.explain')}>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r="0.5" fill="currentColor" stroke="none"/></svg>
				</button>
			{/if}
			<button class="toolbar-btn stop" onclick={() => engine.executeCommand('stop')} title="{t('review.stop')} (Esc)" aria-label={t('review.stop')}>
				{t('review.stop')}
			</button>
			{#if status === 'loading' || status === 'speaking' || status === 'listening' || status === 'explaining' || status === 'hinting'}
				<span class="voice-dot" class:loading={status === 'loading'} class:speaking={status === 'speaking'} class:listening={status === 'listening'} class:explaining={status === 'explaining'} class:hinting={status === 'hinting'}></span>
			{/if}
		</div>
		<div class="top-right">
			<span class="count count-new" class:active={cardState === 'new'}>{counts.new}</span>
			<span class="count-sep">+</span>
			<span class="count count-learning" class:active={cardState === 'learning'}>{counts.learning}</span>
			<span class="count-sep">+</span>
			<span class="count count-review" class:active={cardState === 'review'}>{counts.review}</span>
		</div>
	</div>

	<!-- Card content area -->
	<div class="card-area">
		{#if status === 'waiting'}
			<p class="waiting-text">{t('review.waitingCard', { seconds: learningCountdown })}</p>
		{:else}
			<div class="card-content" role="region" aria-label="Flashcard">
				<div class="question-text">{@html frontHtml}</div>
				{#if phase === 'rating'}
					<hr class="card-divider" />
					<div class="answer-text">{@html backHtml}</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Fixed bottom actions -->
	<div class="bottom-bar">
		{#if undoAvailable}
			<button class="undo-link" onclick={() => engine.undo()}>{t('review.undo')} <kbd>Z</kbd></button>
		{/if}
		{#if phase === 'question' && status !== 'waiting'}
			<div class="bottom-actions">
				<button class="show-answer-btn" onclick={() => engine.executeCommand('answer')}>{t('review.showAnswer')}</button>
			</div>
		{:else if phase === 'rating'}
			<div class="interval-labels">
				<span class="interval">{intervals.again}</span>
				<span class="interval">{intervals.hard}</span>
				<span class="interval">{intervals.good}</span>
				<span class="interval">{intervals.easy}</span>
			</div>
			<div class="rating-buttons">
				<button class="rate-btn again" class:voice-picked={highlightRating === 'again'} onclick={() => engine.executeCommand('again')}>{t('rating.again')}</button>
				<button class="rate-btn hard" class:voice-picked={highlightRating === 'hard'} onclick={() => engine.executeCommand('hard')}>{t('rating.hard')}</button>
				<button class="rate-btn good" class:voice-picked={highlightRating === 'good'} onclick={() => engine.executeCommand('good')}>{t('rating.good')}</button>
				<button class="rate-btn easy" class:voice-picked={highlightRating === 'easy'} onclick={() => engine.executeCommand('easy')}>{t('rating.easy')}</button>
			</div>
		{/if}
	</div>
{/if}

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
		color: #8899cc;
		opacity: 0.85;
	}

	.missing-keys-banner h2 {
		font-size: 1.25rem;
		font-weight: 600;
		color: #d0d8ff;
		margin: 0;
	}

	.missing-keys-banner p {
		font-size: 0.95rem;
		color: #8899bb;
		line-height: 1.6;
		margin: 0;
		max-width: 360px;
	}

	.settings-btn {
		display: inline-block;
		margin-top: 0.5rem;
		padding: 0.75rem 1.75rem;
		background: #3a3a7e;
		color: #d0d0ff;
		border: none;
		border-radius: 10px;
		font-size: 1rem;
		font-weight: 600;
		text-decoration: none;
		transition: filter 0.15s;
	}

	.settings-btn:hover {
		filter: brightness(1.2);
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
		animation: screen-fade-in 0.25s ease both;
	}

	@keyframes screen-fade-in {
		from { opacity: 0; transform: translateY(8px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.start-header {
		margin-bottom: 0.5rem;
	}

	.start-header h1 {
		margin-bottom: 0.35rem;
	}

	.deck-name {
		font-size: 1.1rem;
		color: #8899cc;
		font-weight: 500;
		margin: 0;
		animation: screen-fade-in 0.3s ease both;
	}

	.deck-name-skeleton {
		height: 1.1rem;
		width: 180px;
		margin: 0 auto;
		border-radius: 6px;
		background: linear-gradient(90deg, #2a2a4e 25%, #33335a 50%, #2a2a4e 75%);
		background-size: 200% 100%;
		animation: shimmer 1.2s ease-in-out infinite;
	}

	@keyframes shimmer {
		0% { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}

	.start-hint {
		color: #8080a0;
		font-size: 0.95rem;
		margin: 0.75rem 0 0;
	}

	.start-btn {
		padding: 1rem 2.5rem;
		font-size: 1.2rem;
		background: #4a4a8e;
		color: #e0e0ff;
		border: none;
		border-radius: 12px;
		cursor: pointer;
		margin: 1.5rem 0;
		transition: background 0.15s, transform 0.1s;
	}

	.start-btn:hover {
		background: #5a5aae;
	}

	.start-btn:active {
		transform: scale(0.97);
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
		color: #a8a8b8;
		font-weight: 600;
	}

	.option-input {
		display: block;
		width: 100%;
		margin-top: 0.3rem;
		padding: 0.5rem 0.6rem;
		background: #22223a;
		border: 1px solid #3a3a5e;
		border-radius: 6px;
		color: #e0e0ff;
		font-size: 0.9rem;
		font-family: inherit;
	}

	.option-input:focus {
		outline: none;
		border-color: #5a5a8e;
	}

	.option-checkbox {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9rem;
		color: #e0e0ff;
		cursor: pointer;
	}

	.option-hint {
		color: #8080a0;
		font-size: 0.8rem;
	}

	.help-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		background: transparent;
		border: 1px solid #3a3a5e;
		color: #a8a8cc;
		cursor: pointer;
		font-size: 0.875rem;
		font-family: inherit;
		font-weight: 500;
		padding: 0.5rem 1rem;
		border-radius: 8px;
		margin-top: 1rem;
		transition: border-color 0.15s, color 0.15s, background 0.15s;
	}

	.help-toggle:hover {
		border-color: #5a5a8e;
		color: #d0d0ff;
		background: #22223a;
	}

	.help-chevron {
		transition: transform 0.2s ease;
		opacity: 0.7;
	}

	.help-chevron.open {
		transform: rotate(180deg);
	}

	.commands-help {
		text-align: left;
		max-width: 400px;
		margin: 0.75rem auto 0;
		color: #a8a8b8;
		font-size: 0.9rem;
		background: #1e1e38;
		border: 1px solid #2e2e50;
		border-radius: 10px;
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
		padding-top: 3rem;
	}

	.stat-grid {
		display: flex;
		gap: 2rem;
		justify-content: center;
		margin: 2rem 0;
	}

	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.stat-value {
		font-size: 2rem;
		font-weight: 700;
	}

	.stat-label {
		color: #a8a8b8;
		font-size: 0.85rem;
	}

	.ratings-summary {
		display: flex;
		gap: 1rem;
		justify-content: center;
		flex-wrap: wrap;
		margin-bottom: 2rem;
	}

	.ratings-summary .rating {
		padding: 0.3rem 0.8rem;
		border-radius: 6px;
		font-size: 0.85rem;
	}

	.rating.again { background: #4a2020; color: #ff8888; }
	.rating.hard { background: #4a3a20; color: #ffbb88; }
	.rating.good { background: #204a20; color: #88ff88; }
	.rating.easy { background: #20204a; color: #88bbff; }

	.back-link {
		display: inline-block;
		padding: 0.6rem 1.5rem;
		color: #aaa;
		text-decoration: none;
		border: 1px solid #444;
		border-radius: 8px;
	}

	.back-link:hover {
		border-color: #666;
		color: #ddd;
	}

	/* ========== Toast Notifications ========== */
	.toast-error {
		position: fixed;
		top: max(0.75rem, env(safe-area-inset-top));
		left: 50%;
		transform: translateX(-50%);
		background: #4a2020;
		color: #ff8888;
		padding: 0.5rem 1.2rem;
		border-radius: 8px;
		font-size: 0.85rem;
		font-weight: 600;
		z-index: 100;
		animation: slide-down 0.2s ease;
	}

	.toast-notice {
		position: fixed;
		top: max(0.75rem, env(safe-area-inset-top));
		left: 50%;
		transform: translateX(-50%);
		background: #3a2a10;
		color: #ffcc88;
		padding: 0.5rem 1.2rem;
		border-radius: 8px;
		font-size: 0.85rem;
		font-weight: 600;
		z-index: 100;
		animation: slide-down 0.2s ease;
	}

	@keyframes slide-down {
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
		padding: env(safe-area-inset-top) 0.75rem 0;
		z-index: 50;
		background: #1a1a2e;
	}

	.top-left {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}

	.top-right {
		display: flex;
		align-items: center;
		gap: 0.2rem;
		font-size: 0.9rem;
		font-weight: 600;
	}

	.toolbar-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: 6px;
		border: none;
		background: transparent;
		color: #8080a0;
		cursor: pointer;
		transition: all 0.15s;
	}

	.toolbar-btn:hover {
		background: #2a2a4e;
		color: #e0e0ff;
	}

	.toolbar-btn.off {
		color: #ff8888;
	}

	.toolbar-btn.stop {
		width: auto;
		padding: 0 10px;
		font-size: 0.8rem;
		font-weight: 500;
		letter-spacing: 0.01em;
	}

	.toolbar-btn.stop:hover {
		color: #ff6666;
	}

	.voice-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		margin-left: 0.3rem;
		flex-shrink: 0;
	}

	.voice-dot.loading {
		background: #ffbb88;
		animation: pulse-fade 0.8s ease-in-out infinite;
	}

	.voice-dot.speaking {
		background: #ffbb88;
		animation: pulse-dot 1s ease-in-out infinite;
	}

	.voice-dot.listening {
		background: #88ff88;
		animation: pulse-dot 1.4s ease-in-out infinite;
	}

	.voice-dot.explaining {
		background: #bbaaff;
		animation: pulse-dot 0.8s ease-in-out infinite;
	}

	.voice-dot.hinting {
		background: #ffdd88;
		animation: pulse-dot 0.8s ease-in-out infinite;
	}

	@keyframes pulse-dot {
		0%, 100% { opacity: 1; transform: scale(1); }
		50% { opacity: 0.4; transform: scale(1.3); }
	}

	@keyframes pulse-fade {
		0%, 100% { opacity: 0.3; transform: scale(0.8); }
		50% { opacity: 1; transform: scale(1.2); }
	}


	.count-new { color: #66cc66; }
	.count-learning { color: #ffaa44; }
	.count-review { color: #6699ff; }
	.count-sep { color: #555; font-size: 0.75rem; }

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
	}

	.question-text {
		font-size: 1.4rem;
		margin: 0;
		line-height: 1.5;
	}

	.card-divider {
		border: none;
		border-top: 1px solid #3a3a5e;
		margin: 1.5rem 0;
	}

	.answer-text {
		font-size: 1.2rem;
		margin: 0;
		color: #aaddaa;
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
		color: #6699ff;
		font-weight: 600;
	}

	.answer-text :global(.cloze-answer) {
		color: #66ddaa;
		font-weight: 700;
	}

	.waiting-text {
		font-size: 1.2rem;
		color: #ccaaff;
		text-align: center;
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
		padding-bottom: 0.75rem;
		background: #1a1a2e;
		border-top: 1px solid #2a2a4e;
		z-index: 50;
	}

	.undo-link {
		background: none;
		border: none;
		color: #8080a0;
		cursor: pointer;
		font-size: 0.75rem;
		margin-bottom: 0.3rem;
		display: flex;
		align-items: center;
		gap: 0.3rem;
		animation: fade-in 0.2s ease;
	}

	.undo-link:hover {
		color: #ffcc66;
	}

	.bottom-actions {
		width: 100%;
		max-width: 400px;
	}

	.show-answer-btn {
		width: 100%;
		padding: 0.9rem;
		font-size: 1.05rem;
		font-weight: 600;
		background: #3a3a7e;
		color: #d0d0ff;
		border: none;
		border-radius: 10px;
		cursor: pointer;
		transition: filter 0.15s;
	}

	.show-answer-btn:hover {
		filter: brightness(1.15);
	}

	.interval-labels {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		width: 100%;
		max-width: 400px;
		text-align: center;
		margin-bottom: 0.2rem;
	}

	.interval {
		font-size: 0.7rem;
		color: #8080a0;
	}

	.rating-buttons {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.4rem;
		width: 100%;
		max-width: 400px;
	}

	.rate-btn {
		padding: 0.75rem 0;
		border: none;
		border-radius: 8px;
		font-size: 0.9rem;
		font-weight: 600;
		cursor: pointer;
		transition: filter 0.15s;
	}

	.rate-btn:hover {
		filter: brightness(1.2);
	}

	.rate-btn.again { background: #4a2020; color: #ff8888; }
	.rate-btn.hard { background: #4a3a20; color: #ffbb88; }
	.rate-btn.good { background: #204a20; color: #88ff88; }
	.rate-btn.easy { background: #20204a; color: #88bbff; }

	.rate-btn.voice-picked {
		filter: brightness(1.8);
		transition: filter 0.05s;
	}

	@keyframes fade-in {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
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
</style>

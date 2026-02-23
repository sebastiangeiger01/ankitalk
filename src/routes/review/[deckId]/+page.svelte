<script lang="ts">
	import { page } from '$app/stores';
	import { onDestroy, onMount } from 'svelte';
	import { createReviewEngine, type ReviewEvent, type SessionStats, type StartOptions } from '$lib/client/review-engine';
	import type { ReviewPhase } from '$lib/types';

	const deckId = $derived($page.params.deckId);

	let started = $state(false);
	let phase = $state<ReviewPhase>('question');
	let status = $state<'idle' | 'speaking' | 'listening' | 'explaining' | 'waiting'>('idle');
	let cardsReviewed = $state(0);
	let frontText = $state('');
	let backText = $state('');
	let transcript = $state('');
	let lastCommand = $state('');
	let errorMsg = $state('');
	let sessionEnded = $state(false);
	let stats = $state<SessionStats | null>(null);
	let deckName = $state('');
	let micOn = $state(true);
	let audioOn = $state(true);
	let undoAvailable = $state(false);
	let isLearning = $state(false);
	let learningCountdown = $state(0);
	let countdownInterval: ReturnType<typeof setInterval> | null = null;
	let suspendedNotice = $state('');
	let suspendedTimer: ReturnType<typeof setTimeout> | null = null;
	let tagFilter = $state('');
	let cramMode = $state(false);
	let cramState = $state<'' | 'new' | 'learning' | 'review'>('');

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
				isLearning = event.isLearning;
				lastCommand = '';
				status = 'idle';
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
			case 'transcript':
				transcript = event.text;
				break;
			case 'command':
				lastCommand = event.command;
				break;
			case 'session_end':
				clearCountdown();
				sessionEnded = true;
				stats = event.stats;
				status = 'idle';
				break;
			case 'error':
				errorMsg = event.message;
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
				suspendedNotice = 'Card suspended';
				if (suspendedTimer) clearTimeout(suspendedTimer);
				suspendedTimer = setTimeout(() => { suspendedNotice = ''; }, 3000);
				break;
			}
		}
	});

	async function startReview() {
		started = true;
		errorMsg = '';
		const options: StartOptions = {};
		if (tagFilter.trim()) options.tags = tagFilter.trim();
		if (cramMode) {
			options.mode = 'cram';
			if (cramState) options.cramState = cramState;
		}
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
				engine.executeCommand('again');
				break;
			case '2':
				engine.executeCommand('hard');
				break;
			case '3':
				engine.executeCommand('good');
				break;
			case '4':
				engine.executeCommand('easy');
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

	// Fetch deck name on mount for the start screen
	$effect(() => {
		fetch(`/api/decks/${deckId}`)
			.then((r) => r.json())
			.then((data) => { deckName = (data as { deck: { name: string } }).deck.name; })
			.catch(() => {});
	});

	onDestroy(() => {
		clearCountdown();
		if (suspendedTimer) clearTimeout(suspendedTimer);
		engine.destroy();
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="review-container">
	{#if !started}
		<div class="start-screen">
			<h1>Ready to Review{deckName ? ` — ${deckName}` : ''}</h1>
			<p>Tap the button below to start your voice-controlled review session.</p>

			<button class="start-btn" onclick={startReview}>{cramMode ? 'Start Cram' : 'Start Review'}</button>

			<div class="review-options">
				<label class="option-label">
					Filter by tags
					<input type="text" class="option-input" bind:value={tagFilter} placeholder="tag1, tag2" />
				</label>

				<label class="option-checkbox">
					<input type="checkbox" bind:checked={cramMode} />
					Cram mode <span class="option-hint">(ignore due dates & limits)</span>
				</label>

				{#if cramMode}
					<label class="option-label">
						Cram state filter
						<select class="option-input" bind:value={cramState}>
							<option value="">All states</option>
							<option value="new">New only</option>
							<option value="learning">Learning only</option>
							<option value="review">Review only</option>
						</select>
					</label>
				{/if}
			</div>
			<div class="commands-help">
				<h3>Voice Commands & Keyboard Shortcuts</h3>
				<ul>
					<li><strong>answer / show</strong> — reveal the answer <kbd>Space</kbd></li>
					<li><strong>hint</strong> — hear first few words <kbd>H</kbd></li>
					<li><strong>again / hard / good / easy</strong> — rate <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd></li>
					<li><strong>repeat</strong> — hear it again <kbd>R</kbd></li>
					<li><strong>explain</strong> — ask AI to explain <kbd>E</kbd></li>
					<li><strong>stop</strong> — end session <kbd>Esc</kbd></li>
				</ul>
			</div>
		</div>
	{:else if sessionEnded && stats}
		<div class="summary">
			<h1>Session Complete{deckName ? ` — ${deckName}` : ''}</h1>
			<div class="stat-grid">
				<div class="stat">
					<span class="stat-value">{stats.cardsReviewed}</span>
					<span class="stat-label">Cards Reviewed</span>
				</div>
				<div class="stat">
					<span class="stat-value">{formatDuration(stats.durationMs)}</span>
					<span class="stat-label">Duration</span>
				</div>
			</div>
			<div class="ratings-summary">
				<span class="rating again">Again: {stats.ratings.again}</span>
				<span class="rating hard">Hard: {stats.ratings.hard}</span>
				<span class="rating good">Good: {stats.ratings.good}</span>
				<span class="rating easy">Easy: {stats.ratings.easy}</span>
			</div>
			<a href="/" class="back-link">Back to Dashboard</a>
		</div>
	{:else if status === 'waiting'}
		<div class="active-review">
			<div class="review-header">
				{#if deckName}
					<h2 class="deck-title">{deckName}</h2>
				{/if}
				<div class="toggles">
					<button class="toggle-btn" class:off={!audioOn} onclick={() => engine.toggleAudio()} aria-label={audioOn ? 'Mute audio' : 'Unmute audio'} title={audioOn ? 'Mute audio' : 'Unmute audio'}>
						{#if audioOn}
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
						{:else}
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
						{/if}
					</button>
					<button class="toggle-btn" class:off={!micOn} onclick={() => engine.toggleMic()} aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'} title={micOn ? 'Mute microphone' : 'Unmute microphone'}>
						{#if micOn}
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
						{:else}
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.5-.36 2.18"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
						{/if}
					</button>
				</div>
			</div>

			<div class="waiting-card">
				<p class="waiting-text">Card returning in {learningCountdown}s...</p>
				<span class="reviewed-count">{cardsReviewed} reviewed</span>
			</div>

			<button class="stop-btn" onclick={() => engine.executeCommand('stop')}>Stop Session <kbd>Esc</kbd></button>
		</div>
	{:else}
		<div class="active-review">
			<div class="review-header">
				{#if deckName}
					<h2 class="deck-title">{deckName}</h2>
				{/if}
				<div class="toggles">
					<button class="toggle-btn" class:off={!audioOn} onclick={() => engine.toggleAudio()} aria-label={audioOn ? 'Mute audio' : 'Unmute audio'} title={audioOn ? 'Mute audio' : 'Unmute audio'}>
						{#if audioOn}
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
						{:else}
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
						{/if}
					</button>
					<button class="toggle-btn" class:off={!micOn} onclick={() => engine.toggleMic()} aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'} title={micOn ? 'Mute microphone' : 'Unmute microphone'}>
						{#if micOn}
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
						{:else}
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.5-.36 2.18"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
						{/if}
					</button>
				</div>
			</div>

			<div class="progress-bar-container" aria-live="polite" aria-label="{cardsReviewed} reviewed">
				<span class="progress-text">{cardsReviewed} reviewed</span>
			</div>

			<div class="card-display" role="region" aria-label="Flashcard">
				{#if isLearning}
					<span class="learning-badge">Learning</span>
				{/if}
				<div class="front" aria-label="Question">
					<p>{frontText}</p>
				</div>
				{#if phase === 'rating'}
					<div class="back" aria-label="Answer">
						<p>{backText}</p>
					</div>
				{/if}
			</div>

			<div class="status-bar">
				<span class="phase-badge" aria-label="Current phase: {phase === 'question' ? 'Question' : 'Rating'}" class:question={phase === 'question'} class:rating={phase === 'rating'}>
					{phase === 'question' ? 'Question' : 'Rate It'}
				</span>
				<span class="status-indicator" aria-label="Status: {status}"
					class:speaking={status === 'speaking'}
					class:listening={status === 'listening'}
					class:explaining={status === 'explaining'}>
					{#if status === 'speaking'}
						<span class="viz viz-speaking"><span></span><span></span><span></span></span>
						Speaking...
					{:else if status === 'listening'}
						<span class="viz viz-listening"><span></span><span></span></span>
						Listening...
					{:else if status === 'explaining'}
						Thinking...
					{:else}
						...
					{/if}
				</span>
			</div>

			{#if transcript}
				<p class="transcript">"{transcript}"</p>
			{/if}

			{#if lastCommand}
				<p class="last-command">Command: {lastCommand}</p>
			{/if}

			{#if errorMsg}
				<p class="error">{errorMsg}</p>
			{/if}

			{#if suspendedNotice}
				<p class="suspended-notice">{suspendedNotice}</p>
			{/if}

			<div class="action-buttons" role="group" aria-label={phase === 'question' ? 'Question actions' : 'Rating actions'}>
				{#if phase === 'question'}
					<button class="action-btn show-answer" onclick={() => engine.executeCommand('answer')}>Show Answer <kbd>Space</kbd></button>
					<button class="action-btn hint" onclick={() => engine.executeCommand('hint')}>Hint <kbd>H</kbd></button>
					<button class="action-btn suspend" onclick={() => engine.executeCommand('suspend')}>Suspend <kbd>S</kbd></button>
				{:else}
					<button class="action-btn again" aria-label="Rate: Again (1)" onclick={() => engine.executeCommand('again')}>Again <kbd>1</kbd></button>
					<button class="action-btn hard" aria-label="Rate: Hard (2)" onclick={() => engine.executeCommand('hard')}>Hard <kbd>2</kbd></button>
					<button class="action-btn good" aria-label="Rate: Good (3)" onclick={() => engine.executeCommand('good')}>Good <kbd>3</kbd></button>
					<button class="action-btn easy" aria-label="Rate: Easy (4)" onclick={() => engine.executeCommand('easy')}>Easy <kbd>4</kbd></button>
					<button class="action-btn explain" onclick={() => engine.executeCommand('explain')}>Explain <kbd>E</kbd></button>
					<button class="action-btn suspend" onclick={() => engine.executeCommand('suspend')}>Suspend <kbd>S</kbd></button>
				{/if}
			</div>

			{#if undoAvailable}
				<button class="undo-btn" onclick={() => engine.undo()}>Undo <kbd>Z</kbd></button>
			{/if}

			<div class="voice-hints" aria-label="Available voice commands">
				{#if micOn}
					{#if phase === 'question'}
						<span class="voice-hint-label">Say:</span> answer, hint, again, hard, good, easy, stop
					{:else}
						<span class="voice-hint-label">Say:</span> explain, again, hard, good, easy, repeat, stop
					{/if}
				{:else}
					<span class="mic-off-hint">Mic off — use buttons or keyboard</span>
				{/if}
			</div>

			<button class="stop-btn" onclick={() => engine.executeCommand('stop')}>Stop Session <kbd>Esc</kbd></button>
		</div>
	{/if}
</div>

<style>
	.review-container {
		min-height: 80dvh;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.start-screen {
		text-align: center;
		padding-top: 3rem;
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
	}

	.start-btn:hover {
		background: #5a5aae;
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

	.commands-help {
		text-align: left;
		max-width: 400px;
		margin: 2rem auto 0;
		color: #a8a8b8;
		font-size: 0.9rem;
	}

	.commands-help h3 {
		color: #bbb;
	}

	.commands-help ul {
		padding-left: 1.2rem;
	}

	.commands-help li {
		margin-bottom: 0.3rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
	}

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

	.active-review {
		width: 100%;
		max-width: 600px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		padding-top: 1rem;
	}

	.review-header {
		width: 100%;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.deck-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: #b0b0d0;
	}

	.toggles {
		display: flex;
		gap: 0.4rem;
	}

	.toggle-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: 8px;
		border: 1px solid #3a3a5e;
		background: #22223a;
		color: #a8a8b8;
		cursor: pointer;
		transition: all 0.15s;
	}

	.toggle-btn:hover {
		border-color: #5a5a8e;
		color: #e0e0ff;
	}

	.toggle-btn.off {
		border-color: #4a2020;
		color: #ff8888;
		background: #2a1515;
	}

	/* Progress bar */
	.progress-bar-container {
		width: 100%;
		position: relative;
		height: 24px;
		background: #22223a;
		border-radius: 12px;
		overflow: hidden;
	}

	.progress-text {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.75rem;
		color: #e0e0ff;
		font-weight: 600;
	}

	.card-display {
		width: 100%;
		background: #22223a;
		border-radius: 12px;
		padding: 2rem;
		min-height: 150px;
		position: relative;
	}

	.learning-badge {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		padding: 0.15rem 0.5rem;
		font-size: 0.7rem;
		font-weight: 600;
		border-radius: 4px;
		background: #3a2a5e;
		color: #ccaaff;
	}

	.front p {
		font-size: 1.3rem;
		margin: 0;
	}

	.back {
		margin-top: 1.5rem;
		padding-top: 1.5rem;
		border-top: 1px solid #3a3a5e;
	}

	.back p {
		font-size: 1.1rem;
		margin: 0;
		color: #aaddaa;
	}

	.status-bar {
		display: flex;
		gap: 1rem;
		align-items: center;
	}

	.phase-badge {
		padding: 0.3rem 0.8rem;
		border-radius: 6px;
		font-size: 0.8rem;
		font-weight: 600;
	}

	.phase-badge.question { background: #2a2a5e; color: #aabbff; }
	.phase-badge.rating { background: #2a4a2a; color: #aaffaa; }

	.status-indicator {
		font-size: 0.85rem;
		color: #a8a8b8;
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.status-indicator.speaking { color: #ffbb88; }
	.status-indicator.listening { color: #88ff88; }
	.status-indicator.explaining { color: #bbaaff; }

	.transcript {
		color: #9090a0;
		font-style: italic;
		font-size: 0.85rem;
	}

	.last-command {
		color: #6ecb63;
		font-size: 0.85rem;
		font-weight: 600;
	}

	.error {
		color: #ff6666;
		font-size: 0.85rem;
	}

	.suspended-notice {
		background: #4a2a20;
		color: #ff9988;
		padding: 0.4rem 1rem;
		border-radius: 6px;
		font-size: 0.85rem;
		font-weight: 600;
		animation: fade-in 0.2s ease;
	}

	.action-buttons {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		justify-content: center;
	}

	.action-btn {
		padding: 0.5rem 1.2rem;
		border: none;
		border-radius: 8px;
		font-size: 0.9rem;
		font-weight: 600;
		cursor: pointer;
		transition: filter 0.15s;
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.action-btn:hover {
		filter: brightness(1.2);
	}

	.action-btn.show-answer { background: #3a3a7e; color: #c0c0ff; }
	.action-btn.hint { background: #2a2a4e; color: #a8a8b8; }
	.action-btn.again { background: #4a2020; color: #ff8888; }
	.action-btn.hard { background: #4a3a20; color: #ffbb88; }
	.action-btn.good { background: #204a20; color: #88ff88; }
	.action-btn.easy { background: #20204a; color: #88bbff; }
	.action-btn.explain { background: #2a2a4e; color: #bbaaff; }
	.action-btn.suspend { background: #4a2a20; color: #ff9988; }

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

	.undo-btn {
		padding: 0.35rem 1rem;
		background: #3a2a10;
		border: 1px solid #6a5a30;
		color: #ffcc66;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8rem;
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		animation: fade-in 0.2s ease;
	}

	.undo-btn:hover {
		background: #4a3a20;
		border-color: #8a7a40;
	}

	@keyframes fade-in {
		from { opacity: 0; transform: translateY(-4px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.voice-hints {
		font-size: 0.75rem;
		color: #8080a0;
		text-align: center;
	}

	.voice-hint-label {
		font-weight: 600;
		color: #a8a8b8;
	}

	.mic-off-hint {
		color: #ff8888;
		font-style: italic;
	}

	.stop-btn {
		padding: 0.35rem 1rem;
		background: none;
		border: 1px solid #444;
		color: #a8a8b8;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8rem;
		margin-top: 0.5rem;
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.stop-btn:hover {
		border-color: #e53e3e;
		color: #e53e3e;
	}

	/* Waiting state */
	.waiting-card {
		width: 100%;
		background: #22223a;
		border-radius: 12px;
		padding: 2rem;
		text-align: center;
	}

	.waiting-text {
		font-size: 1.1rem;
		color: #ccaaff;
		margin: 0 0 0.5rem;
	}

	.reviewed-count {
		font-size: 0.85rem;
		color: #a8a8b8;
	}

	/* Mic/audio visualization */
	.viz {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}

	.viz-listening span {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #88ff88;
		animation: pulse-mic 1.4s ease-in-out infinite;
	}

	.viz-listening span:nth-child(2) {
		animation-delay: 0.2s;
		opacity: 0.6;
	}

	.viz-speaking span {
		display: inline-block;
		width: 3px;
		height: 12px;
		border-radius: 2px;
		background: #ffbb88;
		animation: bar-wave 0.8s ease-in-out infinite;
	}

	.viz-speaking span:nth-child(2) {
		animation-delay: 0.15s;
		height: 16px;
	}

	.viz-speaking span:nth-child(3) {
		animation-delay: 0.3s;
		height: 10px;
	}

	@keyframes pulse-mic {
		0%, 100% { transform: scale(1); opacity: 1; }
		50% { transform: scale(1.4); opacity: 0.5; }
	}

	@keyframes bar-wave {
		0%, 100% { transform: scaleY(0.5); }
		50% { transform: scaleY(1.2); }
	}
</style>

<script lang="ts">
	import { page } from '$app/stores';
	import { onDestroy } from 'svelte';
	import { createReviewEngine, type ReviewEvent, type SessionStats } from '$lib/client/review-engine';
	import type { ReviewPhase } from '$lib/types';

	const deckId = $derived($page.params.deckId);

	let started = $state(false);
	let phase = $state<ReviewPhase>('question');
	let status = $state<'idle' | 'speaking' | 'listening' | 'explaining'>('idle');
	let cardIndex = $state(0);
	let cardTotal = $state(0);
	let frontText = $state('');
	let backText = $state('');
	let transcript = $state('');
	let lastCommand = $state('');
	let errorMsg = $state('');
	let sessionEnded = $state(false);
	let stats = $state<SessionStats | null>(null);
	let deckName = $state('');

	const engine = createReviewEngine();

	engine.onEvent((event: ReviewEvent) => {
		switch (event.type) {
			case 'phase_change':
				phase = event.phase;
				break;
			case 'card_change':
				cardIndex = event.index;
				cardTotal = event.total;
				frontText = event.front;
				backText = event.back;
				lastCommand = '';
				break;
			case 'speaking':
				status = 'speaking';
				break;
			case 'listening':
				status = 'listening';
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
		}
	});

	async function startReview() {
		started = true;
		errorMsg = '';
		await engine.start(deckId!);
	}

	function formatDuration(ms: number): string {
		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${minutes}m ${secs}s`;
	}

	// Fetch deck name on mount for the start screen
	$effect(() => {
		fetch(`/api/decks/${deckId}`)
			.then((r) => r.json())
			.then((data) => { deckName = (data as { deck: { name: string } }).deck.name; })
			.catch(() => {});
	});

	onDestroy(() => {
		engine.destroy();
	});
</script>

<div class="review-container">
	{#if !started}
		<div class="start-screen">
			<h1>Ready to Review{deckName ? ` — ${deckName}` : ''}</h1>
			<p>Tap the button below to start your voice-controlled review session.</p>
			<button class="start-btn" onclick={startReview}>Start Review</button>
			<div class="commands-help">
				<h3>Voice Commands</h3>
				<ul>
					<li><strong>answer / show</strong> — reveal the answer</li>
					<li><strong>hint</strong> — hear first few words</li>
					<li><strong>again / hard / good / easy</strong> — rate the card</li>
					<li><strong>repeat</strong> — hear it again</li>
					<li><strong>explain</strong> — ask AI to explain</li>
					<li><strong>stop</strong> — end session</li>
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
	{:else}
		<div class="active-review">
			{#if deckName}
				<h2 class="deck-title">{deckName}</h2>
			{/if}
			<div class="progress" aria-live="polite" aria-label="Card {cardIndex + 1} of {cardTotal}">
				{cardIndex + 1} / {cardTotal}
			</div>

			<div class="card-display" role="region" aria-label="Flashcard">
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

			<div class="action-buttons" role="group" aria-label={phase === 'question' ? 'Question actions' : 'Rating actions'}>
				{#if phase === 'question'}
					<button class="action-btn show-answer" onclick={() => engine.executeCommand('answer')}>Show Answer</button>
					<button class="action-btn hint" onclick={() => engine.executeCommand('hint')}>Hint</button>
				{:else}
					<button class="action-btn again" aria-label="Rate: Again" onclick={() => engine.executeCommand('again')}>Again</button>
					<button class="action-btn hard" aria-label="Rate: Hard" onclick={() => engine.executeCommand('hard')}>Hard</button>
					<button class="action-btn good" aria-label="Rate: Good" onclick={() => engine.executeCommand('good')}>Good</button>
					<button class="action-btn easy" aria-label="Rate: Easy" onclick={() => engine.executeCommand('easy')}>Easy</button>
					<button class="action-btn explain" onclick={() => engine.executeCommand('explain')}>Explain</button>
				{/if}
			</div>

			<div class="voice-hints" aria-label="Available voice commands">
				{#if phase === 'question'}
					<span class="voice-hint-label">Say:</span> answer, hint, again, hard, good, easy, stop
				{:else}
					<span class="voice-hint-label">Say:</span> explain, again, hard, good, easy, repeat, stop
				{/if}
			</div>

			<button class="stop-btn" onclick={() => engine.executeCommand('stop')}>Stop Session</button>
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

	.commands-help {
		text-align: left;
		max-width: 350px;
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

	.deck-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: #b0b0d0;
	}

	.progress {
		color: #a8a8b8;
		font-size: 0.9rem;
	}

	.card-display {
		width: 100%;
		background: #22223a;
		border-radius: 12px;
		padding: 2rem;
		min-height: 150px;
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

	.voice-hints {
		font-size: 0.75rem;
		color: #8080a0;
		text-align: center;
	}

	.voice-hint-label {
		font-weight: 600;
		color: #a8a8b8;
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
	}

	.stop-btn:hover {
		border-color: #e53e3e;
		color: #e53e3e;
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

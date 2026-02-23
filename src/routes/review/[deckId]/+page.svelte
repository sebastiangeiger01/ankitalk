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

	onDestroy(() => {
		engine.destroy();
	});
</script>

<div class="review-container">
	{#if !started}
		<div class="start-screen">
			<h1>Ready to Review</h1>
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
			<h1>Session Complete</h1>
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
			<div class="progress">
				{cardIndex + 1} / {cardTotal}
			</div>

			<div class="card-display">
				<div class="front">
					<p>{frontText}</p>
				</div>
				{#if phase === 'rating'}
					<div class="back">
						<p>{backText}</p>
					</div>
				{/if}
			</div>

			<div class="status-bar">
				<span class="phase-badge" class:question={phase === 'question'} class:rating={phase === 'rating'}>
					{phase === 'question' ? 'Question' : 'Rate It'}
				</span>
				<span class="status-indicator"
					class:speaking={status === 'speaking'}
					class:listening={status === 'listening'}
					class:explaining={status === 'explaining'}>
					{#if status === 'speaking'}
						Speaking...
					{:else if status === 'listening'}
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

			<div class="available-commands">
				{#if phase === 'question'}
					<span>answer</span>
					<span>hint</span>
					<span>again</span>
					<span>hard</span>
					<span>good</span>
					<span>easy</span>
					<span>stop</span>
				{:else}
					<span>explain</span>
					<span>again</span>
					<span>hard</span>
					<span>good</span>
					<span>easy</span>
					<span>repeat</span>
					<span>stop</span>
				{/if}
			</div>
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
		color: #888;
		font-size: 0.9rem;
	}

	.commands-help h3 {
		color: #aaa;
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
		color: #888;
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

	.progress {
		color: #888;
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
		color: #888;
	}

	.status-indicator.speaking { color: #ffbb88; }
	.status-indicator.listening { color: #88ff88; }
	.status-indicator.explaining { color: #bbaaff; }

	.transcript {
		color: #666;
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

	.available-commands {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
		justify-content: center;
	}

	.available-commands span {
		padding: 0.25rem 0.6rem;
		background: #2a2a4e;
		border-radius: 6px;
		font-size: 0.75rem;
		color: #888;
	}
</style>

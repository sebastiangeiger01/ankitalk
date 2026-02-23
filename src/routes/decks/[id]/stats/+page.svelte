<script lang="ts">
	import { page } from '$app/stores';

	const deckId = $derived($page.params.id);

	let loading = $state(true);
	let deckName = $state('');
	let period = $state(30);

	interface CardStates {
		new: number;
		learning: number;
		review: number;
		relearning: number;
		suspended: number;
	}

	interface DayReview {
		day: string;
		again_count: number;
		hard_count: number;
		good_count: number;
		easy_count: number;
		total: number;
		avg_duration_ms: number | null;
	}

	let cardStates = $state<CardStates>({ new: 0, learning: 0, review: 0, relearning: 0, suspended: 0 });
	let dailyReviews = $state<DayReview[]>([]);
	let retentionRate = $state<number | null>(null);

	const totalCards = $derived(cardStates.new + cardStates.learning + cardStates.review + cardStates.relearning + cardStates.suspended);
	const maxDaily = $derived(Math.max(1, ...dailyReviews.map(d => d.total)));

	async function loadStats() {
		loading = true;
		try {
			const [deckRes, statsRes] = await Promise.all([
				fetch(`/api/decks/${deckId}`),
				fetch(`/api/decks/${deckId}/stats?days=${period}`)
			]);

			if (deckRes.ok) {
				const data = (await deckRes.json()) as { deck: { name: string } };
				deckName = data.deck.name;
			}

			if (statsRes.ok) {
				const data = (await statsRes.json()) as {
					cardStates: CardStates;
					dailyReviews: DayReview[];
					retentionRate: number | null;
				};
				cardStates = data.cardStates;
				dailyReviews = data.dailyReviews;
				retentionRate = data.retentionRate;
			}
		} catch {
			// silently fail
		}
		loading = false;
	}

	function setPeriod(days: number) {
		period = days;
		loadStats();
	}

	function stateBarWidth(count: number): string {
		return totalCards > 0 ? `${(count / totalCards) * 100}%` : '0%';
	}

	$effect(() => {
		loadStats();
	});
</script>

<div class="stats-page">
	<a href="/" class="back-link">&larr; Dashboard</a>

	<h1>Statistics{deckName ? ` — ${deckName}` : ''}</h1>

	{#if loading}
		<p class="loading">Loading...</p>
	{:else}
		<section class="section">
			<h2>Card States</h2>
			<div class="state-bar">
				{#if totalCards > 0}
					<div class="state-seg new" style="width: {stateBarWidth(cardStates.new)}" title="New: {cardStates.new}"></div>
					<div class="state-seg learning" style="width: {stateBarWidth(cardStates.learning + cardStates.relearning)}" title="Learning: {cardStates.learning + cardStates.relearning}"></div>
					<div class="state-seg review" style="width: {stateBarWidth(cardStates.review)}" title="Review: {cardStates.review}"></div>
					<div class="state-seg suspended" style="width: {stateBarWidth(cardStates.suspended)}" title="Suspended: {cardStates.suspended}"></div>
				{/if}
			</div>
			<div class="state-legend">
				<span class="legend-item"><span class="dot new"></span> New: {cardStates.new}</span>
				<span class="legend-item"><span class="dot learning"></span> Learning: {cardStates.learning + cardStates.relearning}</span>
				<span class="legend-item"><span class="dot review"></span> Review: {cardStates.review}</span>
				<span class="legend-item"><span class="dot suspended"></span> Suspended: {cardStates.suspended}</span>
			</div>
		</section>

		<section class="section">
			<h2>Retention Rate</h2>
			{#if retentionRate !== null}
				<div class="retention-display">
					<span class="retention-value">{Math.round(retentionRate * 100)}%</span>
					<span class="retention-label">of mature card reviews passed</span>
				</div>
			{:else}
				<p class="no-data">Not enough mature card reviews yet</p>
			{/if}
		</section>

		<section class="section">
			<h2>Daily Reviews</h2>
			<div class="period-selector">
				<button class:active={period === 7} onclick={() => setPeriod(7)}>7d</button>
				<button class:active={period === 30} onclick={() => setPeriod(30)}>30d</button>
				<button class:active={period === 90} onclick={() => setPeriod(90)}>90d</button>
			</div>

			{#if dailyReviews.length === 0}
				<p class="no-data">No reviews in this period</p>
			{:else}
				<div class="chart-container">
					<svg viewBox="0 0 {dailyReviews.length * 24} 120" class="chart" preserveAspectRatio="none">
						{#each dailyReviews as day, i}
							{@const x = i * 24 + 2}
							{@const barW = 20}
							{@const scale = 100 / maxDaily}
							{@const easyH = day.easy_count * scale}
							{@const goodH = day.good_count * scale}
							{@const hardH = day.hard_count * scale}
							{@const againH = day.again_count * scale}
							<!-- stacked bottom-up: again, hard, good, easy -->
							<rect x={x} y={100 - againH} width={barW} height={againH} fill="#ff8888" rx="2">
								<title>{day.day}: Again {day.again_count}</title>
							</rect>
							<rect x={x} y={100 - againH - hardH} width={barW} height={hardH} fill="#ffbb88" rx="2">
								<title>{day.day}: Hard {day.hard_count}</title>
							</rect>
							<rect x={x} y={100 - againH - hardH - goodH} width={barW} height={goodH} fill="#88ff88" rx="2">
								<title>{day.day}: Good {day.good_count}</title>
							</rect>
							<rect x={x} y={100 - againH - hardH - goodH - easyH} width={barW} height={easyH} fill="#88bbff" rx="2">
								<title>{day.day}: Easy {day.easy_count}</title>
							</rect>
						{/each}
					</svg>
				</div>
				<div class="chart-legend">
					<span class="legend-item"><span class="dot again"></span> Again</span>
					<span class="legend-item"><span class="dot hard"></span> Hard</span>
					<span class="legend-item"><span class="dot good"></span> Good</span>
					<span class="legend-item"><span class="dot easy"></span> Easy</span>
				</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	.stats-page {
		max-width: 600px;
		margin: 0 auto;
		padding: 1rem;
	}

	.back-link {
		color: #a8a8b8;
		text-decoration: none;
		font-size: 0.9rem;
	}

	.back-link:hover {
		color: #e0e0ff;
	}

	h1 {
		margin: 1rem 0 1.5rem;
		font-size: 1.4rem;
	}

	.loading, .no-data {
		color: #a8a8b8;
		font-size: 0.9rem;
	}

	.section {
		margin-bottom: 2rem;
	}

	.section h2 {
		font-size: 1rem;
		color: #b0b0d0;
		margin-bottom: 0.75rem;
	}

	/* Card state bar */
	.state-bar {
		display: flex;
		height: 24px;
		border-radius: 6px;
		overflow: hidden;
		background: #22223a;
	}

	.state-seg {
		min-width: 2px;
		transition: width 0.3s ease;
	}

	.state-seg.new { background: #88bbff; }
	.state-seg.learning { background: #ffbb88; }
	.state-seg.review { background: #88ff88; }
	.state-seg.suspended { background: #ff8888; }

	.state-legend, .chart-legend {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		margin-top: 0.5rem;
		font-size: 0.8rem;
		color: #a8a8b8;
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}

	.dot {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		display: inline-block;
	}

	.dot.new { background: #88bbff; }
	.dot.learning { background: #ffbb88; }
	.dot.review { background: #88ff88; }
	.dot.suspended, .dot.again { background: #ff8888; }
	.dot.hard { background: #ffbb88; }
	.dot.good { background: #88ff88; }
	.dot.easy { background: #88bbff; }

	/* Retention */
	.retention-display {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
	}

	.retention-value {
		font-size: 2.5rem;
		font-weight: 700;
		color: #88ff88;
	}

	.retention-label {
		font-size: 0.85rem;
		color: #a8a8b8;
	}

	/* Period selector */
	.period-selector {
		display: flex;
		gap: 0.4rem;
		margin-bottom: 0.75rem;
	}

	.period-selector button {
		padding: 0.3rem 0.8rem;
		border: 1px solid #3a3a5e;
		background: #22223a;
		color: #a8a8b8;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8rem;
	}

	.period-selector button:hover {
		border-color: #5a5a8e;
		color: #e0e0ff;
	}

	.period-selector button.active {
		background: #3a3a6e;
		border-color: #5a5a8e;
		color: #e0e0ff;
	}

	/* Chart */
	.chart-container {
		width: 100%;
		overflow-x: auto;
		background: #22223a;
		border-radius: 8px;
		padding: 0.75rem;
	}

	.chart {
		width: 100%;
		min-width: 200px;
		height: 120px;
	}
</style>

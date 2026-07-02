<script lang="ts">
	import { page } from '$app/stores';
	import { t } from '$lib/i18n';
	import Spinner from '$lib/components/Spinner.svelte';

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
	let desiredRetention = $state(0.9);

	const totalCards = $derived(cardStates.new + cardStates.learning + cardStates.review + cardStates.relearning + cardStates.suspended);
	const maxDaily = $derived(Math.max(1, ...dailyReviews.map(d => d.total)));

	// Headline numbers, all derived from the daily data already on the client.
	const totalReviews = $derived(dailyReviews.reduce((sum, d) => sum + d.total, 0));
	const reviewsPerDay = $derived(totalReviews / period);
	const avgAnswerMs = $derived.by(() => {
		// avg_duration_ms is a per-day average, so weight each day by its review count.
		let weighted = 0;
		let count = 0;
		for (const d of dailyReviews) {
			if (d.avg_duration_ms !== null) {
				weighted += d.avg_duration_ms * d.total;
				count += d.total;
			}
		}
		return count > 0 ? weighted / count : null;
	});

	function formatPerDay(n: number): string {
		return n >= 10 ? String(Math.round(n)) : n.toFixed(1);
	}

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
					desiredRetention?: number;
				};
				cardStates = data.cardStates;
				dailyReviews = data.dailyReviews;
				retentionRate = data.retentionRate;
				desiredRetention = data.desiredRetention ?? 0.9;
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
	<a href="/" class="back-link">&larr; {$t('stats.dashboard')}</a>

	<h1>{$t('stats.title')}{deckName ? ` — ${deckName}` : ''}</h1>

	{#if loading}
		<div class="loading"><Spinner size={26} /></div>
	{:else}
		<p class="tiles-caption">{$t('stats.lastDays', { days: period })}</p>
		<div class="stat-tiles">
			<div class="stat-tile card">
				<span class="tile-value">{totalReviews}</span>
				<span class="tile-label">{$t('stats.totalReviews')}</span>
			</div>
			<div class="stat-tile card">
				<span class="tile-value">{formatPerDay(reviewsPerDay)}</span>
				<span class="tile-label">{$t('stats.reviewsPerDay')}</span>
			</div>
			<div class="stat-tile card">
				<span class="tile-value">{avgAnswerMs !== null ? `${(avgAnswerMs / 1000).toFixed(1)}s` : '—'}</span>
				<span class="tile-label">{$t('stats.avgAnswerTime')}</span>
			</div>
			<div class="stat-tile card">
				<span class="tile-value">{retentionRate !== null ? `${Math.round(retentionRate * 100)}%` : '—'}</span>
				<span class="tile-label">{$t('stats.retentionRate')}</span>
				{#if retentionRate !== null}
					<span class="tile-sub" class:ok={retentionRate >= desiredRetention} class:behind={retentionRate < desiredRetention}>
						<span class="target-dot" aria-hidden="true"></span>
						{$t('stats.retentionTarget', { pct: Math.round(desiredRetention * 100) })}
					</span>
				{:else}
					<span class="tile-sub muted">{$t('stats.noRetention')}</span>
				{/if}
			</div>
		</div>

		<section class="section card">
			<h2>{$t('stats.cardStates')}</h2>
			<div class="state-bar">
				{#if totalCards > 0}
					<div class="state-seg seg-new" style="width: {stateBarWidth(cardStates.new)}" title="{$t('state.new')}: {cardStates.new}"></div>
					<div class="state-seg seg-learning" style="width: {stateBarWidth(cardStates.learning + cardStates.relearning)}" title="{$t('state.learning')}: {cardStates.learning + cardStates.relearning}"></div>
					<div class="state-seg seg-review" style="width: {stateBarWidth(cardStates.review)}" title="{$t('state.review')}: {cardStates.review}"></div>
					<div class="state-seg seg-suspended" style="width: {stateBarWidth(cardStates.suspended)}" title="{$t('state.suspended')}: {cardStates.suspended}"></div>
				{/if}
			</div>
			<div class="state-legend">
				<span class="legend-item"><span class="dot new"></span> {$t('state.new')}: {cardStates.new}</span>
				<span class="legend-item"><span class="dot learning"></span> {$t('state.learning')}: {cardStates.learning + cardStates.relearning}</span>
				<span class="legend-item"><span class="dot review"></span> {$t('state.review')}: {cardStates.review}</span>
				<span class="legend-item"><span class="dot suspended"></span> {$t('state.suspended')}: {cardStates.suspended}</span>
			</div>
		</section>

		<section class="section card">
			<div class="section-head">
				<h2>{$t('stats.dailyReviews')}</h2>
				<div class="period-selector" role="group" aria-label={$t('stats.periodLabel')}>
					<button class:active={period === 7} aria-pressed={period === 7} onclick={() => setPeriod(7)}>7d</button>
					<button class:active={period === 30} aria-pressed={period === 30} onclick={() => setPeriod(30)}>30d</button>
					<button class:active={period === 90} aria-pressed={period === 90} onclick={() => setPeriod(90)}>90d</button>
				</div>
			</div>

			{#if dailyReviews.length === 0}
				<p class="no-data">{$t('stats.noReviews')}</p>
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
							<rect x={x} y={100 - againH} width={barW} height={againH} class="bar bar-again" rx="2">
								<title>{day.day}: {$t('rating.again')} {day.again_count}</title>
							</rect>
							<rect x={x} y={100 - againH - hardH} width={barW} height={hardH} class="bar bar-hard" rx="2">
								<title>{day.day}: {$t('rating.hard')} {day.hard_count}</title>
							</rect>
							<rect x={x} y={100 - againH - hardH - goodH} width={barW} height={goodH} class="bar bar-good" rx="2">
								<title>{day.day}: {$t('rating.good')} {day.good_count}</title>
							</rect>
							<rect x={x} y={100 - againH - hardH - goodH - easyH} width={barW} height={easyH} class="bar bar-easy" rx="2">
								<title>{day.day}: {$t('rating.easy')} {day.easy_count}</title>
							</rect>
						{/each}
					</svg>
				</div>
				<div class="chart-legend">
					<span class="legend-item"><span class="dot again"></span> {$t('rating.again')}</span>
					<span class="legend-item"><span class="dot hard"></span> {$t('rating.hard')}</span>
					<span class="legend-item"><span class="dot good"></span> {$t('rating.good')}</span>
					<span class="legend-item"><span class="dot easy"></span> {$t('rating.easy')}</span>
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
		color: var(--text-muted);
		text-decoration: none;
		font-size: 0.9rem;
	}

	.back-link:hover {
		color: var(--text);
	}

	h1 {
		margin: 1rem 0 1.5rem;
		font-size: 1.4rem;
		/* Deck names are user text and can be arbitrarily long — keep the heading to one line. */
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.loading {
		color: var(--text-muted);
		display: flex;
		justify-content: center;
		padding: 3rem 0;
	}

	.no-data {
		color: var(--text-muted);
		font-size: 0.9rem;
		margin: 0;
	}

	/* Headline stat tiles */
	.tiles-caption {
		margin: 0 0 0.5rem;
		font-size: 0.75rem;
		color: var(--text-subtle);
	}

	.stat-tiles {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	@media (min-width: 640px) {
		.stat-tiles {
			grid-template-columns: repeat(4, 1fr);
		}
	}

	.stat-tile {
		padding: 0.9rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}

	.tile-value {
		font-size: 1.6rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		font-variant-numeric: tabular-nums;
		line-height: 1.15;
	}

	.tile-label {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.tile-sub {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.72rem;
		font-weight: 600;
	}

	.tile-sub.ok {
		color: var(--success);
	}

	.tile-sub.behind {
		color: var(--warning);
	}

	.tile-sub.muted {
		color: var(--text-subtle);
		font-weight: 400;
	}

	.target-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
		flex: none;
	}

	/* Section cards */
	.section {
		padding: 1rem;
		margin-bottom: 1rem;
	}

	.section h2 {
		font-size: 1rem;
		color: var(--text-muted);
		margin: 0 0 0.75rem;
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}

	.section-head h2 {
		margin: 0;
	}

	/* Card state bar. The 2px gaps expose the track between segments so adjacent
	   states stay separable even under color-vision deficiency. */
	.state-bar {
		display: flex;
		gap: 2px;
		height: 24px;
		border-radius: var(--r-sm);
		overflow: hidden;
		background: var(--surface-2);
	}

	.state-seg {
		min-width: 2px;
		transition: width var(--t-med) var(--ease);
	}

	/* Standardized card-state colors: new = info, learning = warning, review = success,
	   suspended = danger. */
	.seg-new { background: var(--info); }
	.seg-learning { background: var(--warning); }
	.seg-review { background: var(--success); }
	.seg-suspended { background: var(--danger-soft); }

	.state-legend, .chart-legend {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		margin-top: 0.5rem;
		font-size: 0.8rem;
		color: var(--text-muted);
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

	.dot.new, .dot.easy { background: var(--info); }
	.dot.learning, .dot.hard { background: var(--warning); }
	.dot.review, .dot.good { background: var(--success); }
	.dot.suspended, .dot.again { background: var(--danger-soft); }

	/* Period selector — active period is a filled primary pill. */
	.period-selector {
		display: flex;
		gap: 0.4rem;
	}

	.period-selector button {
		padding: 0.3rem 0.8rem;
		min-height: 2rem;
		border: 1px solid var(--border);
		background: transparent;
		color: var(--text-muted);
		border-radius: var(--r-pill);
		cursor: pointer;
		font-size: 0.8rem;
		font-family: inherit;
		touch-action: manipulation;
		transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
	}

	.period-selector button:hover {
		border-color: var(--border-strong);
		color: var(--text);
	}

	.period-selector button.active {
		background: var(--primary);
		border-color: transparent;
		color: var(--text-on-primary);
		font-weight: 600;
	}

	/* Chart */
	.chart-container {
		width: 100%;
		overflow-x: auto;
	}

	.chart {
		width: 100%;
		min-width: 200px;
		height: 120px;
	}

	/* Rating colors as classes: SVG presentation attributes can't take var() reliably,
	   CSS fill can. The surface-colored stroke keeps stacked segments separated. */
	.bar {
		stroke: var(--surface);
		stroke-width: 1;
		vector-effect: non-scaling-stroke;
	}

	.bar-again { fill: var(--danger-soft); }
	.bar-hard { fill: var(--warning); }
	.bar-good { fill: var(--success); }
	.bar-easy { fill: var(--info); }
</style>

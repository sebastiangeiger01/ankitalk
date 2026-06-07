<script lang="ts">
	import type { SegmentStatus } from '$lib/listen/types';

	let { segments }: { segments: { seq: number; status: SegmentStatus }[] } = $props();
</script>

<div class="seg-row" role="progressbar" aria-label="Generation progress">
	{#each segments as s (s.seq)}
		<span
			class="pill pill--{s.status}"
			title="Segment {s.seq + 1}: {s.status}"
			aria-label="Segment {s.seq + 1} {s.status}"
		></span>
	{/each}
</div>

<style>
	.seg-row {
		display: flex;
		gap: 0.3rem;
		flex-wrap: wrap;
	}

	.pill {
		flex: 1 1 1.6rem;
		min-width: 1rem;
		max-width: 2.4rem;
		height: 0.5rem;
		border-radius: 99px;
		background: #2a2a4a;
		transition: background 0.2s;
	}

	.pill--done {
		background: #5aba84;
	}

	.pill--failed {
		background: #cc6666;
	}

	.pill--generating {
		background: #6b6bc8;
		animation: pulse 1.1s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% { opacity: 1; transform: scaleY(1); }
		50% { opacity: 0.5; transform: scaleY(0.6); }
	}
</style>

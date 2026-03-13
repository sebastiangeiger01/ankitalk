<script lang="ts">
	interface Props {
		size?: number;
	}
	let { size = 18 }: Props = $props();
</script>

<!-- Single rotating arc — minimal and unobtrusive -->
<svg
	class="spinner"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2.5"
	stroke-linecap="round"
	aria-hidden="true"
>
	<path d="M12 2a10 10 0 0 1 10 10" />
</svg>

<style>
	.spinner {
		animation: spin 0.7s linear infinite;
		flex-shrink: 0;
		vertical-align: middle;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>

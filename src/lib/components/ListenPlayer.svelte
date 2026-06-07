<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n';
	import Spinner from './Spinner.svelte';
	import type { ListenSegmentInfo } from '$lib/listen/types';

	let {
		documentId,
		title,
		segments
	}: {
		documentId: string;
		title: string;
		segments: ListenSegmentInfo[];
	} = $props();

	// Single-track UX: only play contiguous done segments from the start so the audio never
	// jumps over a still-generating gap.
	const playable = $derived.by(() => {
		const sorted = [...segments].sort((a, b) => a.seq - b.seq);
		const out: number[] = [];
		for (const s of sorted) {
			if (s.status === 'done') out.push(s.seq);
			else break;
		}
		return out;
	});
	const total = $derived(playable.length);

	let audioEl = $state<HTMLAudioElement | null>(null);
	let index = $state(0);
	let playing = $state(false);
	let curTime = $state(0);
	let curDur = $state(0);
	let downloading = $state(false);

	const currentSrc = $derived(total ? `/api/listen/${documentId}/segments/${playable[index]}/audio` : '');
	// Overall progress across the whole document, presented as one continuous track.
	const overall = $derived(total ? ((index + (curDur ? curTime / curDur : 0)) / total) * 100 : 0);

	async function playFrom(i: number, offsetSeconds = 0) {
		if (!total) return;
		index = Math.max(0, Math.min(total - 1, i));
		await tick();
		if (!audioEl) return;
		audioEl.load();
		const start = () => {
			if (audioEl && offsetSeconds) audioEl.currentTime = offsetSeconds;
			audioEl?.play().then(() => (playing = true)).catch(() => (playing = false));
		};
		if (offsetSeconds) {
			audioEl.addEventListener('loadedmetadata', start, { once: true });
		} else {
			start();
		}
	}

	function toggle() {
		if (!audioEl || !total) return;
		if (playing) {
			audioEl.pause();
			playing = false;
		} else {
			audioEl.play().then(() => (playing = true)).catch(() => (playing = false));
		}
	}

	function onEnded() {
		if (index < total - 1) playFrom(index + 1);
		else playing = false;
	}

	function seek(event: MouseEvent) {
		if (!total) return;
		const bar = event.currentTarget as HTMLElement;
		const rect = bar.getBoundingClientRect();
		const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
		const target = fraction * total;
		const i = Math.min(total - 1, Math.floor(target));
		const segFraction = target - i;
		playFrom(i, segFraction * (i === index ? curDur : 0) || 0);
	}

	async function download() {
		if (!total) return;
		downloading = true;
		try {
			const blobs: Blob[] = [];
			for (const seq of playable) {
				const res = await fetch(`/api/listen/${documentId}/segments/${seq}/audio`);
				if (!res.ok) throw new Error('fetch failed');
				blobs.push(await res.blob());
			}
			const merged = new Blob(blobs, { type: 'audio/mpeg' });
			const url = URL.createObjectURL(merged);
			const a = document.createElement('a');
			a.href = url;
			a.download = `${title || 'audio'}.mp3`;
			a.click();
			URL.revokeObjectURL(url);
		} catch {
			// best-effort download; ignore failures
		} finally {
			downloading = false;
		}
	}
</script>

<div class="player">
	<audio
		bind:this={audioEl}
		src={currentSrc}
		onended={onEnded}
		ontimeupdate={() => { if (audioEl) curTime = audioEl.currentTime; }}
		onloadedmetadata={() => { if (audioEl) curDur = audioEl.duration || 0; }}
		preload="metadata"
	></audio>

	<button class="play-btn" type="button" onclick={toggle} disabled={!total} aria-label={playing ? t('listen.pause') : t('listen.play')}>
		{#if playing}❚❚{:else}▶{/if}
	</button>

	<div
		class="track"
		role="slider"
		tabindex="0"
		aria-label={t('listen.play')}
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={Math.round(overall)}
		onclick={seek}
		onkeydown={(e) => { if (e.key === 'ArrowRight') playFrom(Math.min(total - 1, index + 1)); if (e.key === 'ArrowLeft') playFrom(Math.max(0, index - 1)); }}
	>
		<div class="track-fill" style={`width:${overall}%`}></div>
	</div>

	<button class="download-btn" type="button" onclick={download} disabled={!total || downloading}>
		{#if downloading}<Spinner size={13} />{/if}
		{downloading ? t('listen.downloading') : t('listen.download')}
	</button>
</div>

<style>
	.player {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		background: #1a1a2e;
		border: 1px solid #2a2a4a;
		border-radius: 12px;
		padding: 0.9rem 1rem;
	}

	.play-btn {
		flex-shrink: 0;
		width: 3rem;
		height: 3rem;
		border-radius: 50%;
		border: 1px solid #5a5a8e;
		background: #3a3a6e;
		color: #e0e0ff;
		font-size: 1rem;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		touch-action: manipulation;
	}

	.play-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.track {
		flex: 1;
		height: 10px;
		border-radius: 99px;
		background: #2a2a4a;
		cursor: pointer;
		overflow: hidden;
	}

	.track-fill {
		height: 100%;
		background: #6b6bc8;
		transition: width 0.15s linear;
	}

	.download-btn {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.45rem 0.8rem;
		background: #22223a;
		border: 1px solid #3a3a5e;
		color: #a8a8c8;
		border-radius: 7px;
		font-size: 0.82rem;
		font-weight: 600;
		cursor: pointer;
		touch-action: manipulation;
	}

	.download-btn:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
</style>

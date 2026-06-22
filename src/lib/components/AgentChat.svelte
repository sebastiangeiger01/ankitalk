<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Conversation, type Conversation as ConversationType, type Mode } from '@elevenlabs/client';
	import { t } from '$lib/i18n';
	import { focusTrap } from '$lib/actions/focusTrap';
	import Spinner from '$lib/components/Spinner.svelte';

	interface Props {
		open: boolean;
		/** Card content + deck info + tags + scheduling state, all seeded as dynamic vars. */
		front: string;
		back: string;
		deckName: string;
		deckId: string;
		tags: string;
		cardState: string;
		cardReps: number;
		cardLapses: number;
		/** App locale, passed to the agent so it answers in EN or DE by default. */
		locale: 'en' | 'de';
		onclose: () => void;
	}

	let {
		open,
		front,
		back,
		deckName,
		deckId,
		tags,
		cardState,
		cardReps,
		cardLapses,
		locale,
		onclose
	}: Props = $props();

	type Phase = 'idle' | 'connecting' | 'listening' | 'speaking' | 'ended' | 'error';

	let phase = $state<Phase>('idle');
	let errorMsg = $state('');
	let messages = $state<{ role: 'user' | 'agent'; text: string }[]>([]);
	let conversation: ConversationType | null = null;
	let sessionStartMs = 0;

	// Auto-start when the modal opens. The browser requires the connect step to be on a
	// user-gesture stack for mic permission, so we rely on the parent only flipping
	// `open=true` from a click handler.
	$effect(() => {
		if (open && phase === 'idle') void start();
	});

	async function start() {
		phase = 'connecting';
		errorMsg = '';
		messages = [];
		try {
			const res = await fetch('/api/agent/session', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					front,
					back,
					deck_name: deckName,
					deck_id: deckId,
					tags,
					card_state: cardState,
					card_reps: cardReps,
					card_lapses: cardLapses,
					locale
				})
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				errorMsg = mapError(body.error, res.status);
				phase = 'error';
				return;
			}
			const data = (await res.json()) as {
				signedUrl: string;
				dynamicVariables: Record<string, string | number | boolean>;
				systemPrompt: string;
				voiceId: string;
				language: 'en' | 'de';
			};

			sessionStartMs = Date.now();
			conversation = await Conversation.startSession({
				signedUrl: data.signedUrl,
				dynamicVariables: data.dynamicVariables,
				overrides: {
					agent: { prompt: { prompt: data.systemPrompt }, language: data.language },
					tts: { voiceId: data.voiceId }
				},
				onConnect: () => (phase = 'listening'),
				onDisconnect: () => onSessionEnded(),
				onMessage: ({ message, role }) => {
					if (!message) return;
					messages = [...messages, { role, text: message }];
				},
				onModeChange: ({ mode }: { mode: Mode }) => {
					// `mode` is "speaking" while the agent is talking, "listening" while it
					// waits for user input. Surface it so the user knows whose turn it is.
					if (phase !== 'connecting' && phase !== 'ended' && phase !== 'error') {
						phase = mode === 'speaking' ? 'speaking' : 'listening';
					}
				},
				onError: (e) => {
					errorMsg = typeof e === 'string' ? e : $t('agent.error');
					phase = 'error';
				}
			});
		} catch (e) {
			errorMsg = e instanceof Error ? e.message : $t('agent.error');
			phase = 'error';
		}
	}

	function mapError(code: string | undefined, status: number): string {
		if (code === 'no_agent') return $t('agent.errors.noAgent');
		if (code === 'no_key') return $t('agent.errors.noKey');
		if (code === 'bad_agent') return $t('agent.errors.badAgent');
		if (code === 'bad_key') return $t('agent.errors.badKey');
		if (status === 429 || code === 'rate_limited') return $t('agent.errors.rateLimited');
		return $t('agent.error');
	}

	function onSessionEnded() {
		if (phase === 'ended' || phase === 'error') return;
		phase = 'ended';
		const seconds = Math.round((Date.now() - sessionStartMs) / 1000);
		if (seconds > 0) {
			void fetch('/api/agent/log', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ duration_seconds: seconds })
			}).catch(() => undefined);
		}
	}

	async function stop() {
		try {
			await conversation?.endSession();
		} catch {
			/* end on disconnected session is fine */
		}
		conversation = null;
	}

	async function close() {
		await stop();
		onclose();
	}

	onDestroy(() => {
		void stop();
	});

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			void close();
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="backdrop"
		role="dialog"
		aria-modal="true"
		aria-label={$t('agent.title')}
		tabindex="-1"
		onkeydown={onKey}
		use:focusTrap
	>
		<div class="modal">
			<div class="head">
				<h2>{$t('agent.title')}</h2>
				<button class="close-btn" onclick={close} aria-label={$t('common.close')}>×</button>
			</div>

			<div class="status" role="status" aria-live="polite">
				{#if phase === 'connecting'}
					<Spinner size={16} />
					<span>{$t('agent.status.connecting')}</span>
				{:else if phase === 'listening'}
					<span class="dot dot--live"></span>
					<span>{$t('agent.status.listening')}</span>
				{:else if phase === 'speaking'}
					<span class="dot dot--speaking"></span>
					<span>{$t('agent.status.speaking')}</span>
				{:else if phase === 'ended'}
					<span>{$t('agent.status.ended')}</span>
				{:else if phase === 'error'}
					<span class="err">{errorMsg || $t('agent.error')}</span>
				{/if}
			</div>

			<div class="transcript" aria-live="polite">
				{#each messages as m, i (i)}
					<div class="bubble" class:user={m.role === 'user'}>
						<span class="who">{m.role === 'user' ? $t('agent.you') : $t('agent.agent')}</span>
						<span class="text">{m.text}</span>
					</div>
				{/each}
				{#if messages.length === 0 && phase !== 'connecting' && phase !== 'error'}
					<p class="hint">{$t('agent.hint')}</p>
				{/if}
			</div>

			<div class="actions">
				<button class="end-btn" onclick={close}>
					{phase === 'ended' || phase === 'error' ? $t('common.close') : $t('agent.endSession')}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed; inset: 0;
		background: rgba(0, 0, 0, 0.7);
		display: flex; align-items: stretch; justify-content: center;
		z-index: 200; padding: 1rem;
	}
	.modal {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1rem 1.1rem;
		width: 100%; max-width: 520px;
		display: flex; flex-direction: column; gap: 0.7rem;
		max-height: 85vh;
	}
	.head { display: flex; justify-content: space-between; align-items: center; }
	.head h2 { margin: 0; font-size: 1.1rem; }
	.close-btn {
		background: none; border: none; color: var(--text-muted);
		font-size: 1.5rem; line-height: 1; cursor: pointer;
		padding: 0.2rem 0.5rem; min-width: 36px; min-height: 36px;
	}
	.close-btn:hover { color: var(--text); }

	.status {
		display: flex; align-items: center; gap: 0.5rem;
		font-size: 0.85rem; color: var(--text-muted);
		min-height: 1.6rem;
	}
	.status .err { color: var(--danger-soft); }
	.dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; display: inline-block; }
	.dot--live { background: var(--success); animation: pulse 1.4s ease-in-out infinite; }
	.dot--speaking { background: var(--primary); animation: pulse 0.8s ease-in-out infinite; }
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	.transcript {
		flex: 1; min-height: 0; overflow-y: auto;
		background: var(--surface);
		border: 1px solid var(--border-muted);
		border-radius: 10px;
		padding: 0.65rem 0.7rem;
		display: flex; flex-direction: column; gap: 0.5rem;
		font-size: 0.92rem; line-height: 1.45;
	}
	.bubble {
		display: flex; flex-direction: column; gap: 0.15rem;
		padding: 0.45rem 0.6rem;
		background: var(--surface-2);
		border-radius: 8px;
	}
	.bubble.user { background: var(--surface-elevated, var(--surface-2)); }
	.who { font-size: 0.7rem; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.05em; }
	.text { color: var(--text); overflow-wrap: anywhere; }
	.hint { color: var(--text-subtle); font-size: 0.85rem; margin: 0; text-align: center; padding: 1rem; }

	.actions { display: flex; justify-content: flex-end; }
	.end-btn {
		background: var(--primary); color: var(--text);
		border: none; border-radius: var(--r-pill);
		padding: 0.55rem 1.1rem;
		font-size: 0.9rem; font-weight: 600;
		cursor: pointer; min-height: 40px;
		touch-action: manipulation;
	}
	.end-btn:hover { background: var(--primary-hover); }
</style>

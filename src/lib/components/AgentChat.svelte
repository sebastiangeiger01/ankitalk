<script lang="ts">
	import { onDestroy } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	// Type-only import (erased at build) so the heavy livekit/WebRTC runtime is NOT bundled into
	// the review route — it's loaded on demand in start() when the tutor actually opens. This
	// keeps deck-open off the critical path of a ~370kB dependency.
	import type { Conversation as ConversationType, Mode } from '@elevenlabs/client';
	import { t } from '$lib/i18n';
	import { focusTrap } from '$lib/actions/focusTrap';

	interface Props {
		open: boolean;
		cardId: string;
		answerRevealed: boolean;
		locale: 'en' | 'de';
		onclose: () => void;
	}

	let {
		open,
		cardId,
		answerRevealed,
		locale,
		onclose
	}: Props = $props();

	type Phase = 'idle' | 'connecting' | 'thinking' | 'listening' | 'speaking' | 'ended' | 'error';

	let phase = $state<Phase>('idle');
	let errorMsg = $state('');
	let messages = $state<{ role: 'user' | 'agent'; text: string }[]>([]);
	let conversation = $state<ConversationType | null>(null);
	let sessionStartMs = 0;
	// The agent opens the conversation itself: we suppress the dashboard greeting (firstMessage
	// override) and inject a hidden intent message so its first spoken turn is a real,
	// card-specific hint or explanation instead of a generic "what brings you here?" greeting.
	let kickoffMessage = '';
	let kickoffShown = false;

	// Typed input lets users who can't (or don't want to) speak still converse with the tutor.
	let draft = $state('');
	// Sending is possible once the live session exists; not while connecting/ended/errored.
	const canSend = $derived(
		conversation !== null && (phase === 'thinking' || phase === 'listening' || phase === 'speaking')
	);
	// The chat "typing" bubble is the single loading indicator: shown while we connect and wait
	// for the tutor's first/next turn. This fills the silent gap that otherwise feels slow.
	const showTyping = $derived(phase === 'connecting' || phase === 'thinking');

	function sendText() {
		const text = draft.trim();
		if (!text || !canSend) return;
		try {
			conversation?.sendUserMessage(text);
			// The typed turn echoes back through onMessage, so we don't add it optimistically.
			draft = '';
		} catch {
			/* a closed session will surface via onDisconnect/onError */
		}
	}

	function onInputKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendText();
		}
	}

	// Auto-start when the modal opens. The browser requires the connect step to be on a
	// user-gesture stack for mic permission, so we rely on the parent only flipping
	// `open=true` from a click handler.
	$effect(() => {
		if (open && phase === 'idle') void start();
	});
	$effect(() => {
		if (!open && phase !== 'idle') {
			phase = 'idle';
			errorMsg = '';
			messages = [];
		}
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
					card_id: cardId,
					answer_revealed: answerRevealed,
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
				conversationToken: string;
				dynamicVariables: Record<string, string | number | boolean>;
				systemPrompt: string;
				voiceId: string;
				language: 'en' | 'de';
			};

			// Before the answer is revealed the student wants a hint; afterwards they want the
			// idea explained. We send this as the opening turn so the agent leads with help.
			kickoffMessage = answerRevealed ? $t('agent.kickoffExplain') : $t('agent.kickoffHint');
			kickoffShown = false;

			const { Conversation } = await import('@elevenlabs/client');

			sessionStartMs = Date.now();
			conversation = await Conversation.startSession({
				conversationToken: data.conversationToken,
				connectionType: 'webrtc',
				dynamicVariables: data.dynamicVariables,
				overrides: {
					agent: { prompt: { prompt: data.systemPrompt }, language: data.language, firstMessage: '' },
					tts: { voiceId: data.voiceId }
				},
				// After connecting we immediately kick off the agent's first turn, so show a
				// "thinking" state until it replies rather than a silent "listening" that reads
				// as if we're waiting on the student.
				onConnect: () => (phase = kickoffMessage ? 'thinking' : 'listening'),
				onDisconnect: () => onSessionEnded(),
				onMessage: ({ message, role }) => {
					if (!message) return;
					// Hide the kickoff turn we inject below so it doesn't read as if the student typed it.
					if (role === 'user' && !kickoffShown && message.trim() === kickoffMessage.trim()) {
						kickoffShown = true;
						return;
					}
					messages = [...messages, { role, text: message }];
				},
				onModeChange: ({ mode }: { mode: Mode }) => {
					// `mode` is "speaking" while the agent is talking, "listening" while it
					// waits for user input. Surface it so the user knows whose turn it is.
					if (phase === 'connecting' || phase === 'ended' || phase === 'error') return;
					if (mode === 'speaking') { phase = 'speaking'; return; }
					// Stay in "thinking" until the kicked-off first turn actually starts, so the
					// silent generation gap doesn't flip to "listening" (the student's turn).
					if (phase === 'thinking') return;
					phase = 'listening';
				},
				onError: (e) => {
					errorMsg = typeof e === 'string' ? e : $t('agent.error');
					phase = 'error';
				}
			});

			// Trigger the agent's first turn immediately so it leads with a hint/explanation
			// rather than waiting on the now-empty greeting. Non-fatal if it fails — the
			// student can simply speak first.
			if (kickoffMessage) {
				try {
					conversation.sendUserMessage(kickoffMessage);
				} catch {
					/* ignore — fall back to the student speaking first */
				}
			}
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
		if (code === 'card_not_found') return $t('agent.error');
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

{#snippet dots()}
	<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>
{/snippet}

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
				<h2>{answerRevealed ? $t('agent.title') : $t('agent.hintTitle')}</h2>
				<button class="close-btn" onclick={close} aria-label={$t('common.close')}>×</button>
			</div>

			<!-- Connecting/thinking show no status text: the chat "typing" bubble below is the single
			     loading indicator. The status row covers the turn-taking states only. -->
			<div class="status" role="status" aria-live="polite">
				{#if phase === 'listening'}
					<span class="dot dot--live"></span>
					<span>{$t('agent.status.listening')}</span>
				{:else if phase === 'speaking'}
					<span class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
					<span>{$t('agent.status.speaking')}</span>
				{:else if phase === 'ended'}
					<span>{$t('agent.status.ended')}</span>
				{:else if phase === 'error'}
					<span class="err">{errorMsg || $t('agent.error')}</span>
				{/if}
			</div>

			<div class="transcript" aria-live="polite">
				{#each messages as m, i (i)}
					<div
						class="bubble"
						class:user={m.role === 'user'}
						in:fly={{ y: 6, duration: 180 }}
					>
						<span class="who">{m.role === 'user' ? $t('agent.you') : $t('agent.agent')}</span>
						<span class="text">{m.text}</span>
					</div>
				{/each}
				{#if showTyping}
					<div class="bubble typing-bubble" in:fade={{ duration: 150 }} out:fade={{ duration: 120 }}>
						<span class="who">{$t('agent.agent')}</span>
						{@render dots()}
						<span class="visually-hidden">{$t('agent.status.thinking')}</span>
					</div>
				{:else if messages.length === 0 && phase !== 'speaking' && phase !== 'error'}
					<p class="hint" in:fade={{ duration: 150 }}>
						{answerRevealed ? $t('agent.hint') : $t('agent.preRevealHint')}
					</p>
				{/if}
			</div>

			<form
				class="composer"
				onsubmit={(e) => { e.preventDefault(); sendText(); }}
			>
				<input
					type="text"
					class="composer-input"
					bind:value={draft}
					onkeydown={onInputKey}
					placeholder={$t('agent.inputPlaceholder')}
					aria-label={$t('agent.inputPlaceholder')}
					disabled={!canSend}
					autocomplete="off"
				/>
				<button type="submit" class="send-btn" disabled={!canSend || !draft.trim()}>
					{$t('agent.send')}
				</button>
			</form>

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
		display: flex; align-items: center; justify-content: center;
		z-index: 200;
		/* Keep clear of the notch / Dynamic Island and the home indicator. */
		padding:
			calc(env(safe-area-inset-top) + 0.75rem) 1rem
			calc(env(safe-area-inset-bottom) + 0.75rem);
	}
	.modal {
		background: var(--bg);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 1rem 1.1rem;
		width: 100%; max-width: 520px;
		display: flex; flex-direction: column; gap: 0.7rem;
		max-height: 85dvh;
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
	/* Three bouncing dots — the universal "composing a reply" affordance. Used inline in the
	   status row (small) and as a tutor bubble while we wait for the first/next turn. */
	.typing { display: inline-flex; align-items: flex-end; gap: 0.34rem; height: 0.9rem; }
	.typing i {
		width: 0.5rem; height: 0.5rem; border-radius: 50%;
		background: var(--primary);
		/* transform+opacity only → the compositor can keep this running even while the main
		   thread is busy negotiating the WebRTC connection. will-change hints layer promotion. */
		will-change: transform, opacity;
		animation: typing-bounce 1.2s ease-in-out infinite both;
	}
	.typing i:nth-child(2) { animation-delay: 0.18s; }
	.typing i:nth-child(3) { animation-delay: 0.36s; }
	@keyframes typing-bounce {
		0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
		40% { transform: translateY(-0.34rem); opacity: 1; }
	}

	/* Animated equalizer while the tutor speaks — reads as "live audio" better than a dot. */
	.bars { display: inline-flex; align-items: center; gap: 0.12rem; height: 0.9rem; }
	.bars i {
		width: 0.18rem; height: 100%; border-radius: 1px;
		background: var(--primary);
		animation: bars-eq 0.9s ease-in-out infinite;
	}
	.bars i:nth-child(2) { animation-delay: 0.15s; }
	.bars i:nth-child(3) { animation-delay: 0.3s; }
	.bars i:nth-child(4) { animation-delay: 0.45s; }
	@keyframes bars-eq {
		0%, 100% { transform: scaleY(0.35); }
		50% { transform: scaleY(1); }
	}

	/* Under Reduce Motion we must NOT freeze the loader — a static "loading" reads as broken.
	   Swap the bounce/equalizer for a gentle opacity pulse (no translation), which is within the
	   spirit of reduced motion while still signalling activity. */
	@media (prefers-reduced-motion: reduce) {
		.typing i {
			animation: dot-fade 1.2s ease-in-out infinite both;
			transform: none;
		}
		.bars i { animation: dot-fade 1.1s ease-in-out infinite both; transform: scaleY(0.7); }
		.dot--live { animation: dot-fade 1.6s ease-in-out infinite; }
	}
	@keyframes dot-fade {
		0%, 100% { opacity: 0.35; }
		50% { opacity: 1; }
	}
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
		align-self: flex-start;
		max-width: 86%;
		display: flex; flex-direction: column; gap: 0.2rem;
		padding: 0.5rem 0.7rem;
		background: var(--surface-2);
		border-radius: 14px;
		border-bottom-left-radius: 5px;
	}
	.bubble.user {
		align-self: flex-end;
		/* Fallback first, then a subtle primary tint where color-mix is supported (iOS 16.2+). */
		background: var(--surface-elevated, var(--surface-2));
		background: color-mix(in srgb, var(--primary) 18%, var(--surface-2));
		border-radius: 14px;
		border-bottom-left-radius: 14px;
		border-bottom-right-radius: 5px;
	}
	.typing-bubble { gap: 0.35rem; padding: 0.6rem 0.75rem; }
	.visually-hidden {
		position: absolute; width: 1px; height: 1px;
		padding: 0; margin: -1px; overflow: hidden;
		clip: rect(0 0 0 0); white-space: nowrap; border: 0;
	}
	.who { font-size: 0.7rem; color: var(--text-subtle); text-transform: uppercase; letter-spacing: 0.05em; }
	.text { color: var(--text); overflow-wrap: anywhere; }
	.hint { color: var(--text-subtle); font-size: 0.85rem; margin: 0; text-align: center; padding: 1rem; }

	.composer { display: flex; gap: 0.5rem; align-items: center; }
	.composer-input {
		flex: 1; min-width: 0;
		background: var(--surface); color: var(--text);
		border: 1px solid var(--border-muted); border-radius: var(--r-pill);
		padding: 0.55rem 0.85rem; font-size: 0.9rem; min-height: 40px;
	}
	.composer-input:focus { outline: none; border-color: var(--primary); }
	.composer-input:disabled { opacity: 0.5; }
	.send-btn {
		background: var(--surface-2); color: var(--text);
		border: 1px solid var(--border-muted); border-radius: var(--r-pill);
		padding: 0.55rem 1rem; font-size: 0.9rem; font-weight: 600;
		cursor: pointer; min-height: 40px; touch-action: manipulation;
	}
	.send-btn:not(:disabled):hover { border-color: var(--primary); }
	.send-btn:disabled { opacity: 0.45; cursor: default; }

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

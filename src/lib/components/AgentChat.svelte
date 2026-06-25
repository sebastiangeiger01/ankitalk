<script lang="ts">
	import { onDestroy } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	// Type-only import (erased at build) so the heavy livekit/WebRTC runtime is NOT bundled into
	// the review route — it's loaded on demand in start() when the tutor actually opens. This
	// keeps deck-open off the critical path of a ~370kB dependency.
	import type { Conversation as ConversationType, Mode, Role } from '@elevenlabs/client';
	import { t } from '$lib/i18n';
	import { focusTrap } from '$lib/actions/focusTrap';
	import { getPushToTalk, setPushToTalk } from '$lib/client/preferences';

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
	// The agent's reply streams in as start/delta/stop parts (onAgentChatResponsePart). We grow
	// the SAME bubble in place (tracked by `streamingIndex`) instead of swapping a temporary
	// bubble for a committed one — swapping re-ran the entrance transition and made the message
	// flicker. When the canonical onMessage lands we just replace the text in that same bubble.
	let messages = $state<{ role: 'user' | 'agent'; text: string; streaming?: boolean }[]>([]);
	let streamingIndex = $state(-1);
	let conversation = $state<ConversationType | null>(null);
	let transcriptEl = $state<HTMLDivElement | null>(null);
	// Screen-reader announcements. The transcript itself is NOT a live region — growing the
	// agent bubble token-by-token would make a reader stutter the reply word-by-word. Instead we
	// push only finished turns (and the connecting notice) into this dedicated polite region, so
	// assistive tech hears each message once, in full.
	let liveAnnouncement = $state('');
	// Keep the transcript pinned to the newest message unless the student has scrolled up to read.
	let stickToBottom = true;
	let sessionStartMs = 0;
	// The agent opens the conversation itself: we suppress the dashboard greeting (firstMessage
	// override) and inject a hidden intent message so its first spoken turn is a real,
	// card-specific hint or explanation instead of a generic "what brings you here?" greeting.
	let kickoffMessage = '';
	let kickoffShown = false;

	// Mic gating. `agentSpeaking` tracks whose turn it is (from onModeChange). In the default
	// half-duplex mode the mic is muted whenever the agent talks, so it can't hear and react to
	// its own voice echoing off the phone speaker. In push-to-talk mode the mic stays muted
	// unless the student is actively holding the talk button (`talking`) — which also doubles as
	// a deliberate barge-in.
	let agentSpeaking = $state(false);
	let pushToTalk = $state(false);
	let talking = $state(false);

	// Typed input lets users who can't (or don't want to) speak still converse with the tutor.
	let draft = $state('');
	// Sending is possible once the live session exists; not while connecting/ended/errored.
	const canSend = $derived(
		conversation !== null && (phase === 'thinking' || phase === 'listening' || phase === 'speaking')
	);
	// The chat "typing" bubble is the loading indicator while we connect / wait for the first
	// turn. Once the agent's reply starts streaming, the growing bubble takes over.
	const showTyping = $derived((phase === 'connecting' || phase === 'thinking') && streamingIndex < 0);

	// Auto-scroll: whenever the transcript content changes, stick to the bottom (unless the
	// student scrolled up). Reading `messages` here makes the effect re-run on every new
	// message and every streamed delta.
	$effect(() => {
		// Track both new messages (length) and streamed deltas (the last bubble's text) so this
		// re-runs on every content change, then pin to the bottom.
		const n = messages.length;
		const lastText = n > 0 ? messages[n - 1].text : '';
		void lastText;
		const el = transcriptEl;
		if (!el || !stickToBottom) return;
		requestAnimationFrame(() => {
			el.scrollTop = el.scrollHeight;
		});
	});

	function onTranscriptScroll() {
		const el = transcriptEl;
		if (!el) return;
		stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
	}

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

	// Single source of truth for the mic: apply the desired mute state whenever the inputs
	// change. Push-to-talk → open only while holding the button; otherwise half-duplex → open
	// only when it's the student's turn. Fire-and-forget; a not-yet-live session ignores it and
	// the effect re-runs once `conversation` is assigned.
	$effect(() => {
		const conv = conversation;
		if (!conv) return;
		const muted = pushToTalk ? !talking : agentSpeaking;
		try {
			void conv.setMicMuted(muted);
		} catch {
			/* session closing — nothing to do */
		}
	});

	function togglePushToTalk() {
		pushToTalk = !pushToTalk;
		talking = false;
		setPushToTalk(pushToTalk);
	}

	function startTalking(e: PointerEvent) {
		if (!pushToTalk) return;
		e.preventDefault();
		// Capture the pointer so we reliably get pointerup even if the finger slides off the
		// button — otherwise the mic could stay open after release.
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		talking = true;
	}
	function stopTalking() {
		if (talking) talking = false;
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
			streamingIndex = -1;
			stickToBottom = true;
			talking = false;
			agentSpeaking = false;
			liveAnnouncement = '';
		}
	});

	async function start() {
		phase = 'connecting';
		errorMsg = '';
		messages = [];
		streamingIndex = -1;
		stickToBottom = true;
		talking = false;
		liveAnnouncement = $t('agent.status.connecting');
		pushToTalk = getPushToTalk();
		// The agent opens with the kickoff turn, so treat the connect window as its turn: the mic
		// stays muted until onModeChange flips to "listening". (In push-to-talk this is moot — the
		// mic only opens while the button is held.)
		agentSpeaking = true;
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
				// Use the headset mic when one is plugged into an iPhone — it sidesteps speaker
				// echo entirely. The half-duplex muting below covers the loudspeaker case.
				preferHeadphonesForIosDevices: true,
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
					if (role === 'agent') {
						// Canonical full text for the turn. If it streamed, replace the text of that
						// same bubble in place (no new node → no flicker); otherwise append it.
						if (streamingIndex >= 0) {
							messages[streamingIndex] = { role: 'agent', text: message };
							streamingIndex = -1;
						} else {
							messages = [...messages, { role, text: message }];
						}
						// Announce the finished reply once, in full.
						liveAnnouncement = message;
						return;
					}
					messages = [...messages, { role, text: message }];
					liveAnnouncement = message;
				},
				onAgentChatResponsePart: ({ text, type }) => {
					if (phase === 'ended' || phase === 'error') return;
					if (type === 'start') {
						// Begin a new agent bubble we grow in place. If a previous stream never got
						// its canonical onMessage, it just stays as a normal bubble.
						if (streamingIndex >= 0 && messages[streamingIndex]) {
							messages[streamingIndex] = { ...messages[streamingIndex], streaming: false };
						}
						messages = [...messages, { role: 'agent', text: '', streaming: true }];
						streamingIndex = messages.length - 1;
					} else if (type === 'delta') {
						if (streamingIndex < 0) {
							messages = [...messages, { role: 'agent', text: '', streaming: true }];
							streamingIndex = messages.length - 1;
						}
						const current = messages[streamingIndex];
						messages[streamingIndex] = { ...current, text: current.text + text };
					}
					// 'stop' leaves the bubble in place; onMessage finalises the canonical text.
				},
				onModeChange: ({ mode }: { mode: Mode }) => {
					// `mode` is "speaking" while the agent is talking, "listening" while it
					// waits for user input. This drives both the UI turn indicator and the mic
					// gate (see the $effect): in half-duplex the mic is muted while the agent
					// speaks so it can't react to its own echo off the phone speaker.
					agentSpeaking = mode === 'speaking';
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

	// Re-attempt after a failed connect. End any half-open session first, then drop back to
	// 'idle' so the auto-start effect kicks off a fresh start() (awaiting stop() before that
	// avoids a new session being nulled by the old one's teardown).
	async function retry() {
		errorMsg = '';
		await stop();
		phase = 'idle';
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
		transition:fade={{ duration: 120 }}
	>
		<div class="modal" in:fly={{ y: 10, duration: 200 }}>
			<div class="head">
				<h2>{answerRevealed ? $t('agent.title') : $t('agent.hintTitle')}</h2>
				<button class="close-btn" onclick={close} aria-label={$t('common.close')}>×</button>
			</div>

			<!-- Connecting/thinking show no status text: the chat "typing" bubble below is the single
			     loading indicator. The status row covers the turn-taking states only. -->
			<div class="status" role="status" aria-live="polite">
				{#if phase === 'listening'}
					{#if pushToTalk && !talking}
						<span class="dot"></span>
						<span>{$t('agent.ptt.muted')}</span>
					{:else}
						<span class="dot dot--live"></span>
						<span>{$t('agent.status.listening')}</span>
					{/if}
				{:else if phase === 'speaking'}
					<span class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
					<span>{$t('agent.status.speaking')}</span>
				{:else if phase === 'ended'}
					<span>{$t('agent.status.ended')}</span>
				{:else if phase === 'error'}
					<span class="err">{errorMsg || $t('agent.error')}</span>
				{/if}
			</div>

			<!-- Polite live region for assistive tech: announces finished turns once (see
			     liveAnnouncement). The visible transcript is intentionally not a live region. -->
			<p class="visually-hidden" aria-live="polite" role="status">{liveAnnouncement}</p>

			<div class="transcript" bind:this={transcriptEl} onscroll={onTranscriptScroll}>
				{#each messages as m, i (i)}
					<div
						class="bubble"
						class:user={m.role === 'user'}
						in:fly={{ y: 6, duration: 180 }}
					>
						<span class="who">{m.role === 'user' ? $t('agent.you') : $t('agent.agent')}</span>
						{#if m.streaming && !m.text}
							{@render dots()}
							<span class="visually-hidden">{$t('agent.status.thinking')}</span>
						{:else}
							<span class="text">{m.text}</span>
						{/if}
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

			{#if pushToTalk}
				<div class="ptt-zone">
					<button
						type="button"
						class="ptt-btn"
						class:talking
						onpointerdown={startTalking}
						onpointerup={stopTalking}
						onpointercancel={stopTalking}
						onlostpointercapture={stopTalking}
						disabled={!canSend}
						aria-pressed={talking}
					>
						<span class="ptt-icon" aria-hidden="true">
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
						</span>
						{talking ? $t('agent.ptt.talking') : $t('agent.ptt.hold')}
					</button>
					<p class="ptt-caption">{$t('agent.ptt.caption')}</p>
				</div>
			{/if}

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
				<button
					type="button"
					class="ptt-switch"
					class:on={pushToTalk}
					role="switch"
					aria-checked={pushToTalk}
					onclick={togglePushToTalk}
					title={$t('agent.ptt.switchHint')}
				>
					<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
					<span class="switch-label">{$t('agent.ptt.label')}</span>
				</button>
				<div class="actions-right">
					{#if phase === 'error'}
						<button class="retry-btn" type="button" onclick={retry}>
							{$t('agent.retry')}
						</button>
					{/if}
					<button class="end-btn" onclick={close}>
						{phase === 'ended' || phase === 'error' ? $t('common.close') : $t('agent.endSession')}
					</button>
				</div>
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

	/* Hold-to-talk: a big, obvious press target. `touch-action: none` keeps the press-and-hold
	   from scrolling/selecting on iOS; `user-select: none` stops the label highlighting. */
	.ptt-btn {
		display: flex; align-items: center; justify-content: center; gap: 0.5rem;
		width: 100%; min-height: 52px;
		background: var(--surface-2); color: var(--text);
		border: 1px solid var(--border-muted); border-radius: var(--r-pill);
		font-size: 0.95rem; font-weight: 600;
		cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none;
		transition: background 0.12s ease, border-color 0.12s ease, transform 0.08s ease;
	}
	.ptt-zone { display: flex; flex-direction: column; gap: 0.3rem; }
	.ptt-btn .ptt-icon { display: inline-flex; }
	.ptt-btn.talking {
		background: color-mix(in srgb, var(--primary) 26%, var(--surface-2));
		border-color: var(--primary);
		transform: scale(0.99);
	}
	.ptt-btn:disabled { opacity: 0.45; cursor: default; }
	.ptt-caption {
		margin: 0; text-align: center;
		font-size: 0.78rem; color: var(--text-subtle);
	}

	.actions { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
	/* The push-to-talk control is a SWITCH (mode on/off), deliberately styled unlike the big
	   hold-to-talk button so it doesn't read as the talk action itself. */
	.ptt-switch {
		display: inline-flex; align-items: center; gap: 0.5rem;
		background: none; border: none; padding: 0.3rem 0.1rem;
		color: var(--text-muted); font-size: 0.82rem; font-weight: 600;
		cursor: pointer; min-height: 40px; touch-action: manipulation;
	}
	.switch-track {
		position: relative; flex-shrink: 0;
		width: 36px; height: 20px; border-radius: 999px;
		background: var(--surface-2); border: 1px solid var(--border-muted);
		transition: background 0.15s ease, border-color 0.15s ease;
	}
	.switch-thumb {
		position: absolute; top: 1px; left: 1px;
		width: 16px; height: 16px; border-radius: 50%;
		background: var(--text-subtle);
		transition: transform 0.15s ease, background 0.15s ease;
	}
	.ptt-switch.on { color: var(--text); }
	.ptt-switch.on .switch-track {
		background: color-mix(in srgb, var(--primary) 55%, transparent);
		border-color: var(--primary);
	}
	.ptt-switch.on .switch-thumb { transform: translateX(16px); background: #fff; }
	.actions-right { display: flex; align-items: center; gap: 0.5rem; }
	.retry-btn {
		background: var(--surface-2); color: var(--text);
		border: 1px solid var(--border-muted); border-radius: var(--r-pill);
		padding: 0.55rem 1.1rem; font-size: 0.9rem; font-weight: 600;
		cursor: pointer; min-height: 40px; touch-action: manipulation;
	}
	.retry-btn:hover { border-color: var(--primary); }
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

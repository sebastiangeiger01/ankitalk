import type { Action } from 'svelte/action';

/**
 * Focus-trap action. Attach to a modal/dialog container; on mount it stores the previously
 * focused element, moves focus into the container, and cycles Tab/Shift+Tab between the
 * first and last focusable descendants. On destroy it restores focus to whoever had it
 * before the modal opened.
 *
 * Usage: `<div use:focusTrap role="dialog">…</div>`
 *
 * Pass `false` to disable temporarily (e.g. modal is mounted but `open === false`):
 * `<div use:focusTrap={open}>…</div>`.
 *
 * Replaces five hand-rolled focus blocks that each implemented a subset of this behavior;
 * the most common bug they shared was Tab being able to escape the modal to the page behind.
 */
const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isVisible(el: HTMLElement): boolean {
	// offsetParent is null for `display: none` (and elements detached from layout); good
	// enough proxy for "user can actually see and interact with this".
	return el.offsetParent !== null;
}

function getFocusable(node: HTMLElement): HTMLElement[] {
	return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
}

export const focusTrap: Action<HTMLElement, boolean | undefined> = (node, enabled = true) => {
	let active = false;
	let previouslyFocused: HTMLElement | null = null;

	function onKey(e: KeyboardEvent) {
		if (e.key !== 'Tab') return;
		const focusable = getFocusable(node);
		if (focusable.length === 0) {
			// Nothing to focus; trap by parking on the container itself.
			e.preventDefault();
			node.focus();
			return;
		}
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const current = document.activeElement as HTMLElement | null;
		if (e.shiftKey) {
			if (current === first || !node.contains(current)) {
				e.preventDefault();
				last.focus();
			}
		} else if (current === last || !node.contains(current)) {
			e.preventDefault();
			first.focus();
		}
	}

	function activate() {
		if (active) return;
		previouslyFocused = document.activeElement as HTMLElement | null;
		node.addEventListener('keydown', onKey);
		// Use a microtask so the container is laid out (focusables are findable) before we
		// move focus into it. Some modals render their first focusable conditionally.
		queueMicrotask(() => {
			if (!active) return;
			if (!node.contains(document.activeElement)) {
				const focusable = getFocusable(node);
				(focusable[0] ?? node).focus();
			}
		});
		active = true;
	}

	function deactivate() {
		if (!active) return;
		node.removeEventListener('keydown', onKey);
		// Restore focus to the trigger if it's still in the DOM and focusable.
		if (previouslyFocused && document.contains(previouslyFocused)) {
			previouslyFocused.focus();
		}
		previouslyFocused = null;
		active = false;
	}

	if (enabled) activate();

	return {
		update(nextEnabled = true) {
			if (nextEnabled && !active) activate();
			else if (!nextEnabled && active) deactivate();
		},
		destroy() {
			deactivate();
		}
	};
};

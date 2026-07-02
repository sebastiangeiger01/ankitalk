/**
 * Transient "Saved ✓" feedback for instant-save controls, keyed by control group.
 *
 * Usage: `const flags = new SavedFlags()`, call `flags.flash('provider', ok)` after a
 * save attempt, and render `<SavedFlag status={flags.get('provider')} />` next to the
 * control's label. Success flags clear themselves after ~1.5s; error flags stay until
 * the next attempt so the user can see why the control snapped back.
 */
export type SavedFlagStatus = 'saved' | 'error' | undefined;

export class SavedFlags {
	#flags = $state<Record<string, SavedFlagStatus>>({});
	#timers = new Map<string, ReturnType<typeof setTimeout>>();

	flash(group: string, ok: boolean): void {
		const pending = this.#timers.get(group);
		if (pending) {
			clearTimeout(pending);
			this.#timers.delete(group);
		}
		this.#flags[group] = ok ? 'saved' : 'error';
		if (ok) {
			this.#timers.set(
				group,
				setTimeout(() => {
					this.#flags[group] = undefined;
					this.#timers.delete(group);
				}, 1500)
			);
		}
	}

	get(group: string): SavedFlagStatus {
		return this.#flags[group];
	}
}

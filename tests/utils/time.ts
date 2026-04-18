/**
 * Deterministic wall-clock control for drip/scheduling tests (§18.9).
 *
 * Usage:
 *
 * ```ts
 * import { afterEach } from "vitest";
 * import { fakeNow, restoreNow } from "../../utils/time.js";
 *
 * afterEach(restoreNow);
 *
 * it("unlocks 7 days after enrolment", () => {
 *   fakeNow("2026-06-08T00:00:00.000Z");
 *   // ...engine call that checks Date.now()...
 * });
 * ```
 *
 * Design notes:
 *   - Uses Vitest's fake timers under the hood. `vi.setSystemTime` overrides
 *     both `Date.now()` and `new Date()` for the test's scope, matching the
 *     spec in §18.3.
 *   - `fakeNow` is additive: calling it twice inside one test simply moves
 *     the clock forward (or backward) from the most recent pin.
 *   - `restoreNow` is the idempotent cleanup — safe to wire into
 *     `afterEach(restoreNow)` at the top of any file.
 *   - `withFakeNow` wraps a callback for tests that prefer a scoped form
 *     over the afterEach dance.
 */

import { vi } from "vitest";

let active = false;

/**
 * Pin the wall clock to `iso`. Enables fake timers if they weren't already.
 * Subsequent `Date.now()` / `new Date()` / `Date.parse(...)` calls use the
 * pinned time. Pair with `restoreNow` (or an `afterEach(restoreNow)`).
 */
export function fakeNow(iso: string): Date {
	const target = new Date(iso);
	if (Number.isNaN(target.getTime())) {
		throw new Error(`fakeNow: "${iso}" is not a valid ISO-8601 timestamp.`);
	}
	if (!active) {
		// shouldAdvanceTime: false — the clock stands still so tests are
		// deterministic. Explicit `fakeNow(...)` moves it forward.
		vi.useFakeTimers({ shouldAdvanceTime: false });
		active = true;
	}
	vi.setSystemTime(target);
	return target;
}

/**
 * Release the fake clock. Idempotent — safe to call from `afterEach` even
 * when no test in the file pinned the clock.
 */
export function restoreNow(): void {
	if (!active) return;
	vi.useRealTimers();
	active = false;
}

/**
 * Scoped variant: runs `fn` with the clock pinned to `iso`, restores on
 * return or throw. Handy for one-off assertions that shouldn't leak fake
 * timers to sibling tests sharing a file.
 */
export async function withFakeNow<T>(iso: string, fn: () => Promise<T> | T): Promise<T> {
	const wasActive = active;
	fakeNow(iso);
	try {
		return await fn();
	} finally {
		if (!wasActive) restoreNow();
	}
}

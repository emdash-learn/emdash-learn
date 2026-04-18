/**
 * Drip scheduling — PURE functions (T07 / §22).
 *
 * `unlocksAt(enrollment, lesson, mode)` computes the ISO timestamp at which
 * a lesson becomes available for a given enrollment. No `ctx`, no I/O.
 *
 * Modes:
 *   - `immediate`: drip_offset_days is ignored. Unlocks at `enrolledAt`.
 *   - `relative` : unlocks at `enrolledAt + drip_offset_days` (in UTC days).
 *
 * In both modes `scheduled_at` acts as a floor — if the lesson is pinned to
 * an absolute release date after the drip-computed date, the floor wins.
 * This supports "drip content weekly BUT no earlier than April 15."
 *
 * Unit tests in `tests/unit/engine/drip.test.ts` cover all four combinations
 * of (immediate/relative) × (scheduled/unscheduled).
 */

export interface DripEnrollment {
	enrolledAt: string;
}

export interface DripLesson {
	dripOffsetDays?: number;
	scheduledAt?: string | null;
}

export type DripMode = "immediate" | "relative";

const DAY_MS = 24 * 60 * 60 * 1000;

function addDaysIso(iso: string, days: number): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	return new Date(t + days * DAY_MS).toISOString();
}

function maxIso(a: string, b: string): string {
	const ta = Date.parse(a);
	const tb = Date.parse(b);
	if (Number.isNaN(ta)) return b;
	if (Number.isNaN(tb)) return a;
	return ta >= tb ? a : b;
}

export function unlocksAt(
	enrollment: DripEnrollment,
	lesson: DripLesson,
	mode: DripMode,
): string {
	const base =
		mode === "relative" && lesson.dripOffsetDays && lesson.dripOffsetDays > 0
			? addDaysIso(enrollment.enrolledAt, lesson.dripOffsetDays)
			: enrollment.enrolledAt;

	if (lesson.scheduledAt) {
		return maxIso(base, lesson.scheduledAt);
	}
	return base;
}

/**
 * Convenience predicate: is the lesson unlocked right now?
 */
export function isUnlocked(
	enrollment: DripEnrollment,
	lesson: DripLesson,
	mode: DripMode,
	now: Date,
): boolean {
	const unlock = Date.parse(unlocksAt(enrollment, lesson, mode));
	if (Number.isNaN(unlock)) return true;
	return now.getTime() >= unlock;
}

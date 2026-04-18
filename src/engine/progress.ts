/**
 * Progress engine (T06).
 *
 * Three concerns, four exported functions per §22:
 *   1. `tick`  — heartbeat from the lesson player every ~15s (D20). Upserts the
 *      `progress` row and, when `percentComplete >= 90`, auto-promotes the
 *      lesson to "complete" via `markLessonComplete`. The 90% threshold is the
 *      auto-complete rule pinned in §8.2 (T06 acceptance) and §21 Phase 2.
 *   2. `markLessonComplete` — the single entrypoint that finalises a lesson.
 *      Called by both the `progress:complete` route AND by `tick` when the
 *      90% threshold trips. Writes the authoritative completed row first
 *      (§8.3 invariant), emits `lesson:completed`, then evaluates whether the
 *      whole course is now done — if it is, flips `enrollments.completedAt`
 *      and emits `course:completed` so T09 can issue a certificate downstream.
 *   3. `getForUser` — paginates a user's progress rows for a course. Uses the
 *      composite `[userId, courseId]` index declared in the descriptor (§5.3),
 *      so it's a point lookup, not a scan.
 *   4. `evaluateCourseComplete` — pure-ish predicate over storage: "are all
 *      published lessons in this course complete for this user?" Surfaced as
 *      its own function so reconcilers (T14) can re-check completion without
 *      duplicating the logic.
 *
 * Course-completion definition (§12 Q26): the user has a completed `progress`
 * row for every published lesson in the course, including preview lessons.
 * Preview lessons are visible without enrollment (§5.2) but are not flagged
 * "optional for completion" anywhere in the schema, so v1 treats them as
 * required. Adding an `optional_for_completion` lesson flag is an additive
 * v1.1 change with no migration.
 *
 * Authz/idempotency conventions (§24): every mutating function returns
 * `Result<T>` (§17.5), `LEARN_*` error codes only (§17.6), and the event-bus
 * idempotency markers (§17.4) ensure re-driving a route never double-emits.
 * The progress row itself is keyed by a deterministic `(userId, lessonId)`
 * id, so duplicate ticks coalesce into one row.
 */

import type { PluginContext, StorageCollection } from "emdash";

import { LEARN_ERRORS, LESSONS_COLLECTION_SLUG } from "../constants.js";
import type { CourseCompleted, LessonCompleted } from "../types/engine.js";
import type { Enrollment, Progress } from "../types/storage.js";
import { emit } from "./event-bus.js";
import { err, ok, type Result } from "./result.js";

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

/**
 * Narrow `ctx.storage[name]` out of the generic record. Plugin storage
 * collections are declared in the descriptor (see `sandbox-entry.ts`); a
 * missing collection is a programmer error (descriptor drift), not a
 * request-time failure mode — mirrors the `authz.ts` helper.
 */
function getCollection<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	const collection = (ctx.storage as Record<string, StorageCollection | undefined>)[name];
	if (!collection) {
		throw new Error(`Plugin storage collection "${name}" is not declared in the descriptor.`);
	}
	return collection as StorageCollection<T>;
}

/**
 * Deterministic id for a `(userId, lessonId)` progress row. Using a derived
 * id (rather than a random ulid) means a duplicate tick from the player
 * coalesces into a single row — no read-then-decide race, no orphan rows.
 *
 * Encoded so neither field can break the separator: any user/lesson id that
 * contained `__` would still parse unambiguously because we never split on it.
 */
function progressId(userId: string, lessonId: string): string {
	return `prog__${userId}__${lessonId}`;
}

// ---------------------------------------------------------------------------
// Lesson lookup (content collection)
// ---------------------------------------------------------------------------

interface LessonContext {
	courseId: string;
	status: string;
}

/**
 * Read the minimum fields the engine cares about from the `lessons` content
 * collection. The `course` field is a content reference — its raw value is
 * the referenced course's content id (string). See `tests/utils/seed.ts`'s
 * `seedLesson` for the matching write shape.
 *
 * Returns `null` when the lesson does not exist or the `course` field is
 * missing — callers translate to `LEARN_LESSON_LOCKED`.
 */
async function readLessonContext(
	ctx: PluginContext,
	lessonId: string,
): Promise<LessonContext | null> {
	if (!ctx.content) return null;
	const item = await ctx.content.get(LESSONS_COLLECTION_SLUG, lessonId);
	if (!item) return null;
	const courseRef = item.data["course"];
	if (typeof courseRef !== "string" || !courseRef) return null;
	return { courseId: courseRef, status: item.status };
}

interface PublishedLesson {
	id: string;
}

/**
 * List every published lesson belonging to `courseId`. We can't filter by the
 * `course` reference field server-side (`ContentListWhere` only supports
 * `status` + `locale` per emdash's content API), so we paginate
 * `status=published` and filter client-side. At v1 scale (D42) this stays
 * cheap; v1.1+ may rollup `lessonsTotal` per course if it ever shows up in a
 * profile.
 */
async function listPublishedLessonsForCourse(
	ctx: PluginContext,
	courseId: string,
): Promise<PublishedLesson[]> {
	if (!ctx.content) return [];
	const matches: PublishedLesson[] = [];
	let cursor: string | undefined;
	// Sequential by design: cursor depends on the previous page.
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await ctx.content.list(LESSONS_COLLECTION_SLUG, {
			where: { status: "published" },
			limit: 100,
			cursor,
		});
		for (const lesson of page.items) {
			if (lesson.data["course"] === courseId) matches.push({ id: lesson.id });
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
	return matches;
}

// ---------------------------------------------------------------------------
// Progress queries
// ---------------------------------------------------------------------------

interface ProgressLookup {
	id: string;
	row: Progress;
}

/**
 * Look up the (user, lesson) progress row by deterministic id. Faster than
 * `query()` because it's a primary-key fetch.
 */
async function getProgressByLesson(
	ctx: PluginContext,
	userId: string,
	lessonId: string,
): Promise<ProgressLookup | null> {
	const collection = getCollection<Progress>(ctx, "progress");
	const id = progressId(userId, lessonId);
	const row = await collection.get(id);
	if (!row) return null;
	// The deterministic id ties the row to (userId, lessonId); double-check the
	// row's own fields match in case the id ever collides (defensive but cheap).
	if (row.userId !== userId || row.lessonId !== lessonId) return null;
	return { id, row };
}

async function getEnrollment(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<{ id: string; row: Enrollment } | null> {
	const collection = getCollection<Enrollment>(ctx, "enrollments");
	const result = await collection.query({ where: { userId, courseId }, limit: 1 });
	const item = result.items[0];
	if (!item) return null;
	return { id: item.id, row: item.data };
}

// ---------------------------------------------------------------------------
// Public API (matches §22 signatures)
// ---------------------------------------------------------------------------

export interface TickInput {
	lessonId: string;
	positionSeconds: number;
	percentComplete: number;
}

/**
 * Auto-complete threshold for `tick`. §8.2 / §21 Phase 2 / T06 acceptance row
 * pin this at 90% — exposed as a constant so tests can reference the same
 * source of truth.
 */
export const PROGRESS_AUTO_COMPLETE_THRESHOLD = 90;

/**
 * Heartbeat from the lesson player. Upserts the `progress` row and triggers
 * `markLessonComplete` when the percent crosses the auto-complete threshold.
 *
 * Validation rules:
 *   - User must be enrolled in the lesson's course (`LEARN_NOT_ENROLLED`).
 *   - Lesson must exist and have a course reference (`LEARN_LESSON_LOCKED`
 *     covers both missing-lesson and orphaned-lesson cases — they're both
 *     "you cannot record progress against this lesson").
 *
 * The function is monotonic on `percentComplete`: it never lets the value
 * regress (re-running a stale tick from a slow client doesn't reset progress).
 * `positionSeconds` is overwritten freely — that's the resume cursor and the
 * latest report wins.
 */
export async function tick(
	ctx: PluginContext,
	userId: string,
	input: TickInput,
): Promise<Result<Progress>> {
	const lessonCtx = await readLessonContext(ctx, input.lessonId);
	if (!lessonCtx) {
		return err(LEARN_ERRORS.LESSON_LOCKED, `Lesson ${input.lessonId} is not available.`);
	}

	const enrollment = await getEnrollment(ctx, userId, lessonCtx.courseId);
	if (!enrollment || enrollment.row.revokedAt) {
		return err(
			LEARN_ERRORS.NOT_ENROLLED,
			`User ${userId} is not enrolled in course ${lessonCtx.courseId}.`,
		);
	}

	const collection = getCollection<Progress>(ctx, "progress");
	const existing = await getProgressByLesson(ctx, userId, input.lessonId);
	const now = new Date().toISOString();

	// Already-complete rows are immutable on the percent dimension — once
	// completedAt is set we never walk the bar back.
	if (existing?.row.completedAt) {
		const refreshed: Progress = {
			...existing.row,
			positionSeconds: input.positionSeconds,
		};
		await collection.put(existing.id, refreshed);
		return ok(refreshed);
	}

	const monotonicPercent = Math.max(input.percentComplete, existing?.row.percentComplete ?? 0);
	const next: Progress = {
		userId,
		courseId: lessonCtx.courseId,
		lessonId: input.lessonId,
		startedAt: existing?.row.startedAt ?? now,
		percentComplete: monotonicPercent,
		positionSeconds: input.positionSeconds,
	};

	const id = existing?.id ?? progressId(userId, input.lessonId);
	await collection.put(id, next);

	// Auto-complete crossing — only once per (user, lesson). The next branch
	// returns the post-completion row so the route handler reflects the new
	// state immediately.
	if (monotonicPercent >= PROGRESS_AUTO_COMPLETE_THRESHOLD) {
		const completed = await markLessonComplete(ctx, userId, input.lessonId);
		if (!completed.ok) return completed as Result<Progress>;
		const refreshed = await getProgressByLesson(ctx, userId, input.lessonId);
		return ok(refreshed?.row ?? next);
	}

	return ok(next);
}

/**
 * Finalize a lesson as complete and propagate completion upward.
 *
 * Writes the authoritative completed `progress` row first (§8.3), emits
 * `lesson:completed` for downstream handlers (T09 issues certificates,
 * T14 sends emails), then evaluates whether the course is now done. Course
 * completion writes `enrollments.completedAt` *before* emitting
 * `course:completed` — same row-first-then-emit invariant.
 *
 * Idempotent: re-calling on an already-complete lesson is a no-op for the
 * row write, and the event bus's `handled:` markers (§17.4) ensure
 * downstream handlers never run twice for the same key.
 */
export async function markLessonComplete(
	ctx: PluginContext,
	userId: string,
	lessonId: string,
): Promise<Result<{ courseComplete: boolean }>> {
	const lessonCtx = await readLessonContext(ctx, lessonId);
	if (!lessonCtx) {
		return err(LEARN_ERRORS.LESSON_LOCKED, `Lesson ${lessonId} is not available.`);
	}

	const enrollment = await getEnrollment(ctx, userId, lessonCtx.courseId);
	if (!enrollment || enrollment.row.revokedAt) {
		return err(
			LEARN_ERRORS.NOT_ENROLLED,
			`User ${userId} is not enrolled in course ${lessonCtx.courseId}.`,
		);
	}

	const progress = getCollection<Progress>(ctx, "progress");
	const existing = await getProgressByLesson(ctx, userId, lessonId);
	const now = new Date().toISOString();

	const completedRow: Progress = {
		userId,
		courseId: lessonCtx.courseId,
		lessonId,
		startedAt: existing?.row.startedAt ?? now,
		positionSeconds: existing?.row.positionSeconds,
		percentComplete: 100,
		completedAt: existing?.row.completedAt ?? now,
	};
	const id = existing?.id ?? progressId(userId, lessonId);
	await progress.put(id, completedRow);

	const lessonEvent: LessonCompleted = {
		name: "lesson:completed",
		key: `lc:${userId}:${lessonId}`,
		data: completedRow,
		critical: true,
	};
	await emit(lessonEvent, ctx);

	const courseDone = await evaluateCourseComplete(ctx, userId, lessonCtx.courseId);
	if (!courseDone.ok) return courseDone as Result<{ courseComplete: boolean }>;
	if (!courseDone.data) return ok({ courseComplete: false });

	// Authoritative row write first, then emit (§8.3).
	const enrollments = getCollection<Enrollment>(ctx, "enrollments");
	const completedEnrollment: Enrollment = {
		...enrollment.row,
		completedAt: enrollment.row.completedAt ?? now,
	};
	await enrollments.put(enrollment.id, completedEnrollment);

	const courseEvent: CourseCompleted = {
		name: "course:completed",
		key: `cc:${userId}:${lessonCtx.courseId}`,
		data: completedEnrollment,
		critical: true,
	};
	await emit(courseEvent, ctx);

	return ok({ courseComplete: true });
}

/**
 * Paginated read of a single user's progress for a single course. Uses the
 * composite `[userId, courseId]` index declared on the `progress` collection
 * in the descriptor — this is the hot path for the lesson-player UI which
 * needs every lesson's status.
 */
export async function getForUser(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<Result<Progress[]>> {
	const collection = getCollection<Progress>(ctx, "progress");
	const out: Progress[] = [];
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await collection.query({
			where: { userId, courseId },
			limit: 100,
			cursor,
		});
		for (const item of page.items) out.push(item.data);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
	return ok(out);
}

/**
 * `true` iff the user has a completed `progress` row for every published
 * lesson in the course. Returns `false` (not an error) when the course has
 * zero published lessons — an empty course can't be "completed."
 *
 * See §12 Q26 for the "all published lessons including preview" rule.
 */
export async function evaluateCourseComplete(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<Result<boolean>> {
	const lessons = await listPublishedLessonsForCourse(ctx, courseId);
	if (lessons.length === 0) return ok(false);

	const progress = await getForUser(ctx, userId, courseId);
	if (!progress.ok) return progress as Result<boolean>;

	const completedLessonIds = new Set(
		progress.data.filter((row) => row.completedAt).map((row) => row.lessonId),
	);
	const allComplete = lessons.every((lesson) => completedLessonIds.has(lesson.id));
	return ok(allComplete);
}

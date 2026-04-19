/**
 * Content lifecycle hooks (§21 Phase 5 — deletion guards).
 *
 * Exposes a single `contentBeforeDelete` handler that refuses destructive
 * operations which would orphan plugin-owned rows. emdash fires
 * `content:beforeDelete` right before it writes the delete, and treats a
 * `false` return as "veto — do not proceed." The handler also logs the
 * user-visible reason via `ctx.log.warn` so admins can see why the delete
 * was blocked; the hook signature is `boolean | void`, so the refusal
 * signal travels through the return value, not a thrown error.
 *
 * Rules implemented:
 *   - `courses`: refuse when ANY non-revoked enrollment references the
 *     course. Uses the `(courseId,…)` index from the plugin descriptor, so
 *     the refuse-on-first-active-row check stays O(one page).
 *     Error code: `LEARN_ERRORS.COURSE_HAS_ENROLLMENTS`.
 *   - `lessons`: refuse when ANY row in the `progress` collection
 *     references the lesson. Progress rows are immutable once completed
 *     and cheap to paginate — refuse on the first hit.
 *     Error code: `LEARN_ERRORS.LESSON_HAS_PROGRESS`.
 *   - Any other collection: return `void` so emdash proceeds normally.
 *
 * Registration lives in `src/sandbox-entry.ts`'s compose step (wired up by
 * the orchestrator after merge). This file only owns the handler body.
 */

import type { ContentDeleteEvent, PluginContext, StorageCollection } from "emdash";

import {
	COURSES_COLLECTION_SLUG,
	LEARN_ERRORS,
	LESSONS_COLLECTION_SLUG,
	TOPICS_COLLECTION_SLUG,
} from "../constants.js";
import type { Enrollment, StepProgress } from "../types/storage.js";

/**
 * Typed access to a named plugin-storage collection. Mirrors the pattern
 * used by the engine modules (see `engine/enrollments.ts::enrollmentsStore`)
 * — a missing collection means the descriptor is misconfigured, which is a
 * programmer error and should surface loudly rather than silently allowing
 * a destructive delete to proceed.
 */
function storageFor<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	const store = (ctx.storage as Record<string, StorageCollection | undefined>)[name];
	if (!store) {
		throw new Error(`hooks/content: ctx.storage.${name} is not declared on the descriptor.`);
	}
	return store as StorageCollection<T>;
}

/**
 * Refuse-if-any-active check against the `enrollments` collection for a
 * given `courseId`. Returns `true` when a non-revoked row exists. Paginates
 * defensively: the common case is "first page includes an active row",
 * but if a course has many historical revoked rows we still cursor through
 * until we either find an active one or exhaust the stream.
 */
async function hasActiveEnrollment(ctx: PluginContext, courseId: string): Promise<boolean> {
	const coll = storageFor<Enrollment>(ctx, "enrollments");
	let cursor: string | undefined;
	do {
		const page = await coll.query({ where: { courseId }, limit: 100, cursor });
		for (const row of page.items) {
			const revokedAt = row.data.revokedAt;
			if (revokedAt === undefined || revokedAt === null) {
				return true;
			}
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return false;
}

/**
 * Refuse-if-any check against the `step_progress` collection for a given
 * step (lesson or topic). A single existing row is enough to block the delete.
 */
async function hasAnyProgress(ctx: PluginContext, stepId: string): Promise<boolean> {
	const coll = storageFor<StepProgress>(ctx, "step_progress");
	const page = await coll.query({ where: { stepId }, limit: 1 });
	return page.items.length > 0;
}

/**
 * Refuse-if-any topic references the given lessonId. Topics live in their
 * own content collection (`topics`); we paginate with the same client-side
 * filter pattern as the curriculum engine.
 */
async function hasTopicReferencingLesson(ctx: PluginContext, lessonId: string): Promise<boolean> {
	if (!ctx.content) return false;
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await ctx.content.list(TOPICS_COLLECTION_SLUG, { limit: 100, cursor });
		for (const item of page.items) {
			if (item.data["lesson"] === lessonId) return true;
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
	return false;
}

/**
 * Refuse-if-any lesson or topic references the given courseId.
 */
async function hasContentReferencingCourse(ctx: PluginContext, courseId: string): Promise<boolean> {
	if (!ctx.content) return false;
	for (const collection of [LESSONS_COLLECTION_SLUG, TOPICS_COLLECTION_SLUG]) {
		let cursor: string | undefined;
		/* oxlint-disable no-await-in-loop */
		do {
			const page = await ctx.content.list(collection, { limit: 100, cursor });
			for (const item of page.items) {
				if (item.data["course"] === courseId) return true;
			}
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor);
		/* oxlint-enable no-await-in-loop */
	}
	return false;
}

/**
 * `content:beforeDelete` handler — enforces §21 Phase 5 deletion guards.
 *
 * Returns:
 *   - `false` to veto the delete (emdash halts before touching the row).
 *   - `void` (undefined) to allow the delete to proceed.
 */
export async function contentBeforeDelete(
	event: ContentDeleteEvent,
	ctx: PluginContext,
): Promise<boolean | void> {
	if (event.collection === COURSES_COLLECTION_SLUG) {
		if (await hasActiveEnrollment(ctx, event.id)) {
			ctx.log.warn(
				`[${LEARN_ERRORS.COURSE_HAS_ENROLLMENTS}] refusing to delete course ${event.id}: active enrollments exist`,
			);
			return false;
		}
		if (await hasContentReferencingCourse(ctx, event.id)) {
			ctx.log.warn(
				`[${LEARN_ERRORS.COURSE_HAS_ENROLLMENTS}] refusing to delete course ${event.id}: lessons or topics still reference it`,
			);
			return false;
		}
		return;
	}

	if (event.collection === LESSONS_COLLECTION_SLUG) {
		if (await hasAnyProgress(ctx, event.id)) {
			ctx.log.warn(
				`[${LEARN_ERRORS.LESSON_HAS_PROGRESS}] refusing to delete lesson ${event.id}: progress rows exist`,
			);
			return false;
		}
		if (await hasTopicReferencingLesson(ctx, event.id)) {
			ctx.log.warn(
				`[${LEARN_ERRORS.LESSON_HAS_PROGRESS}] refusing to delete lesson ${event.id}: topics still reference it`,
			);
			return false;
		}
		return;
	}

	if (event.collection === TOPICS_COLLECTION_SLUG) {
		if (await hasAnyProgress(ctx, event.id)) {
			ctx.log.warn(
				`[${LEARN_ERRORS.LESSON_HAS_PROGRESS}] refusing to delete topic ${event.id}: progress rows exist`,
			);
			return false;
		}
		return;
	}

	// Any other content collection is not owned by this plugin — no-op.
	return;
}

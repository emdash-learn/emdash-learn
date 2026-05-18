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

import type {
	ContentDeleteEvent,
	ContentPublishStateChangeEvent,
	PluginContext,
	StorageCollection,
} from "emdash";

import {
	COURSES_COLLECTION_SLUG,
	LEARN_ERRORS,
	LESSONS_COLLECTION_SLUG,
	TOPICS_COLLECTION_SLUG,
} from "../constants.js";
import type { CourseContentIndexRow, Enrollment, StepProgress } from "../types/storage.js";

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

// ---------------------------------------------------------------------------
// course_content_index projection sync (AUDIT C3)
// ---------------------------------------------------------------------------

const CONTENT_INDEX_COLLECTION = "course_content_index";

/**
 * Deterministic storage id for a projection row. Encoding all three key
 * fields prevents collisions across courses and step types.
 */
function contentIndexId(courseId: string, stepType: "lesson" | "topic", stepId: string): string {
	return `idx__${courseId}__${stepType}__${stepId}`;
}

function contentIndexStore(ctx: PluginContext): StorageCollection<CourseContentIndexRow> {
	return storageFor<CourseContentIndexRow>(ctx, CONTENT_INDEX_COLLECTION);
}

function fieldStr(data: Record<string, unknown>, key: string): string | undefined {
	const v = data[key];
	return typeof v === "string" && v ? v : undefined;
}

function fieldNum(data: Record<string, unknown>, key: string): number | undefined {
	const v = data[key];
	return typeof v === "number" ? v : undefined;
}

function fieldBool(data: Record<string, unknown>, key: string): boolean | undefined {
	const v = data[key];
	if (typeof v === "boolean") return v;
	if (v === 1) return true;
	if (v === 0) return false;
	return undefined;
}

/**
 * Upsert a lesson row into `course_content_index`. Called from
 * `contentAfterPublish` (status is implicitly "published") and from the
 * backfill reconciler.
 */
async function upsertLessonIndexRow(
	ctx: PluginContext,
	content: Record<string, unknown>,
): Promise<void> {
	const id = typeof content["id"] === "string" ? content["id"] : undefined;
	if (!id) return;
	const data = (content["data"] ?? {}) as Record<string, unknown>;
	const courseId = fieldStr(data, "course");
	if (!courseId) return;

	const row: CourseContentIndexRow = {
		courseId,
		stepType: "lesson",
		stepId: id,
		order: fieldNum(data, "order") ?? 0,
		status: "published",
	};
	const publishedAt = content["publishedAt"];
	if (typeof publishedAt === "string") row.publishedAt = publishedAt;
	const scheduledAt = content["scheduledAt"];
	if (typeof scheduledAt === "string") row.scheduledAt = scheduledAt;
	const dur = fieldNum(data, "duration_seconds");
	if (dur !== undefined) row.durationSeconds = dur;
	const isPreview = fieldBool(data, "is_preview");
	if (isPreview !== undefined) row.isPreview = isPreview;
	const requiresPrevious = fieldBool(data, "requires_previous");
	if (requiresPrevious !== undefined) row.requiresPrevious = requiresPrevious;
	const dripOffsetDays = fieldNum(data, "drip_offset_days");
	if (dripOffsetDays !== undefined) row.dripOffsetDays = dripOffsetDays;

	const rowId = contentIndexId(courseId, "lesson", id);
	await contentIndexStore(ctx).put(rowId, row);
}

/**
 * Upsert a topic row into `course_content_index`. Called from
 * `contentAfterPublish` (status is implicitly "published") and from the
 * backfill reconciler.
 */
async function upsertTopicIndexRow(
	ctx: PluginContext,
	content: Record<string, unknown>,
): Promise<void> {
	const id = typeof content["id"] === "string" ? content["id"] : undefined;
	if (!id) return;
	const data = (content["data"] ?? {}) as Record<string, unknown>;
	const courseId = fieldStr(data, "course");
	if (!courseId) return;

	const row: CourseContentIndexRow = {
		courseId,
		stepType: "topic",
		stepId: id,
		order: fieldNum(data, "order") ?? 0,
		status: "published",
	};
	const lessonId = fieldStr(data, "lesson");
	if (lessonId) row.lessonId = lessonId;
	const publishedAt = content["publishedAt"];
	if (typeof publishedAt === "string") row.publishedAt = publishedAt;
	const scheduledAt = content["scheduledAt"];
	if (typeof scheduledAt === "string") row.scheduledAt = scheduledAt;
	const dur = fieldNum(data, "duration_seconds");
	if (dur !== undefined) row.durationSeconds = dur;
	const requiresPrevious = fieldBool(data, "requires_previous");
	if (requiresPrevious !== undefined) row.requiresPrevious = requiresPrevious;

	const rowId = contentIndexId(courseId, "topic", id);
	await contentIndexStore(ctx).put(rowId, row);
}

/**
 * Remove a lesson row from `course_content_index` when a lesson is
 * deleted or moved to draft/trashed status.
 *
 * We must look up the existing row first to get courseId (not in the
 * delete event). Falls back to a query against the stepId index when
 * the deterministic id is unknown.
 */
async function deleteIndexRowById(
	ctx: PluginContext,
	stepType: "lesson" | "topic",
	stepId: string,
): Promise<void> {
	const store = contentIndexStore(ctx);
	// Try a query to find all matching rows for this stepId — necessary because
	// we don't know courseId at delete time.
	const page = await store.query({ where: { stepType, stepId }, limit: 10 });
	for (const row of page.items) {
		try {
			await store.delete(row.id);
		} catch {
			// Best-effort; log nothing — the beforeDelete guard already vetoed
			// deletes that would leave progress orphans.
		}
	}
}

/**
 * `content:afterPublish` handler — upserts the `course_content_index` row
 * when a lesson or topic transitions into the published state. Other
 * collections are not owned by this projection.
 */
export async function contentAfterPublish(
	event: ContentPublishStateChangeEvent,
	ctx: PluginContext,
): Promise<void> {
	if (event.collection === LESSONS_COLLECTION_SLUG) {
		await upsertLessonIndexRow(ctx, event.content);
		return;
	}
	if (event.collection === TOPICS_COLLECTION_SLUG) {
		await upsertTopicIndexRow(ctx, event.content);
	}
}

/**
 * `content:afterUnpublish` handler — removes the `course_content_index` row
 * when a lesson or topic leaves the published state, so stale rows never
 * leak into curriculum reads.
 */
export async function contentAfterUnpublish(
	event: ContentPublishStateChangeEvent,
	ctx: PluginContext,
): Promise<void> {
	const id = typeof event.content["id"] === "string" ? event.content["id"] : undefined;
	if (!id) return;
	if (event.collection === LESSONS_COLLECTION_SLUG) {
		await deleteIndexRowById(ctx, "lesson", id);
		return;
	}
	if (event.collection === TOPICS_COLLECTION_SLUG) {
		await deleteIndexRowById(ctx, "topic", id);
	}
}

/**
 * `content:afterDelete` handler — removes projection rows when content is
 * permanently deleted or trashed.
 */
export async function contentAfterDelete(
	event: ContentDeleteEvent,
	ctx: PluginContext,
): Promise<void> {
	if (event.collection === LESSONS_COLLECTION_SLUG) {
		await deleteIndexRowById(ctx, "lesson", event.id);
		return;
	}
	if (event.collection === TOPICS_COLLECTION_SLUG) {
		await deleteIndexRowById(ctx, "topic", event.id);
		return;
	}
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

/**
 * Comment enrollment gate (T13 / §21 Phase 5).
 *
 * Emdash fires `comment:beforeCreate` before it persists a new comment. When
 * the admin setting `commentGateRequiresEnrollment` is `true`, this handler
 * refuses comments posted on a `lessons` content item by a user who is not
 * actively enrolled in the lesson's parent course. Every other case passes
 * through — the gate is scoped narrowly on purpose so blog-style posts and
 * other non-lesson collections are never affected.
 *
 * Decision tree (in order):
 *
 *   1. KV `settings:commentGateRequiresEnrollment` !== true          → allow.
 *   2. `event.comment.collection` !== "lessons"                       → allow.
 *   3. `event.comment.authorUserId` is null (anonymous commenter)     → refuse.
 *   4. Lesson row missing or has no `course` field (data inconsistency
 *      — emdash itself will reject via other paths, no reason to pile on)
 *                                                                      → allow.
 *   5. No active enrollment row (either absent or `revokedAt` set)     → refuse.
 *   6. Otherwise                                                       → allow.
 *
 * Return contract (from emdash `CommentBeforeCreateHandler`):
 *   - `false`          — reject the comment.
 *   - `void` / `event` — allow it through (modified or not).
 *
 * This hook never throws — a hook failure in emdash aborts the whole pipeline,
 * which would be strictly worse than silently allowing a comment when the
 * environment is in an unexpected shape.
 */

import type { CommentBeforeCreateEvent, PluginContext, StorageCollection } from "emdash";

import { LESSONS_COLLECTION_SLUG } from "../constants.js";
import { settingKey } from "../kv-keys.js";
import type { Enrollment } from "../types/storage.js";

/**
 * `comment:beforeCreate` handler implementing the lesson-comment enrollment
 * gate. Exported for registration in `sandbox-entry.ts` (wiring is deferred —
 * T13 only lands the handler and its test).
 */
export async function commentBeforeCreate(
	event: CommentBeforeCreateEvent,
	ctx: PluginContext,
): Promise<CommentBeforeCreateEvent | false | void> {
	const gate = await ctx.kv.get<boolean>(settingKey("commentGateRequiresEnrollment"));
	if (gate !== true) return;

	if (event.comment.collection !== LESSONS_COLLECTION_SLUG) return;

	const authorId = event.comment.authorUserId;
	if (!authorId) {
		ctx.log.warn("comment gate refused: anonymous commenter cannot be enrolled");
		return false;
	}

	// Gate is ON but content access is unavailable — fail closed (H5).
	// Failing open here would let unenrolled users comment whenever content
	// resolution is misconfigured.
	if (!ctx.content) {
		ctx.log.warn("comment gate: ctx.content unavailable — refusing comment to fail closed");
		return false;
	}
	const lesson = await ctx.content.get(LESSONS_COLLECTION_SLUG, event.comment.contentId);
	const courseId = (lesson?.data as Record<string, unknown> | undefined)?.["course"] as
		| string
		| undefined;
	if (!courseId) return;

	const enrollments = (ctx.storage as Record<string, StorageCollection | undefined>)[
		"enrollments"
	] as StorageCollection<Enrollment> | undefined;
	if (!enrollments) return;

	const page = await enrollments.query({
		where: { userId: authorId, courseId },
		limit: 1,
	});
	const row = page.items[0];
	if (!row || row.data.revokedAt) {
		ctx.log.warn(
			`comment gate refused: user ${authorId} has no active enrollment in course ${courseId}`,
		);
		return false;
	}

	return;
}

/**
 * Instructor assignment engine (§22, §5.3 `course_instructors`, §6.3
 * `instructor:set` / `instructor:unset`).
 *
 * Responsibilities:
 *   - `assign(ctx, courseId, userId, role)` — create or update the
 *     `course_instructors` row for `(courseId, userId)`. Idempotent: re-assigning
 *     the same role is a no-op (still returns `ok` with the existing row);
 *     re-assigning a *different* role updates the row in place.
 *   - `unassign(ctx, courseId, userId)` — drop the row. Re-driving on a missing
 *     row is also a no-op success — matches the §24 idempotency convention so
 *     the route handler never has to disambiguate "first unassign" from "retry".
 *   - `listForCourse(ctx, courseId)` / `listForUser(ctx, userId)` — point queries
 *     against the composite/single-field indexes declared in
 *     `src/sandbox-entry.ts`.
 *   - `isInstructorOf(ctx, userId, courseId)` — hot path used by `authz.ts`
 *     (`requireInstructor`) and later wave handlers; returns a plain boolean
 *     so callers can branch without unwrapping a `Result`.
 *
 * No engine events are emitted (§8.2 has no instructor-related catalog entry,
 * so this module skips the event-bus integration entirely — see §12 Q26 for
 * the rationale should v1.1 introduce one).
 *
 * Audit logging is via `ctx.log.info` on every successful mutation per the
 * §24 audit convention (`ctx.log.*`, not `console.*`).
 */

import type { PluginContext, StorageCollection } from "emdash";
import { ulid } from "emdash";

import { LEARN_ERRORS } from "../constants.js";
import type { CourseInstructor, InstructorRole } from "../types/storage.js";
import { err, ok, type Result } from "./result.js";

/**
 * Storage-collection name. Centralized so a typo here surfaces at compile
 * time rather than as a "collection not declared" runtime throw.
 */
const COURSE_INSTRUCTORS = "course_instructors";

/**
 * Narrow `ctx.storage[name]` out of the generic
 * `Record<string, StorageCollection>` access type. The descriptor declares
 * `course_instructors` with a composite `(courseId, userId)` unique index, so
 * the collection is always present at runtime; absence is a programmer error
 * (descriptor drift), not a request-time failure mode.
 */
function instructorsCollection(ctx: PluginContext): StorageCollection<CourseInstructor> {
	const collection = (ctx.storage as Record<string, StorageCollection | undefined>)[
		COURSE_INSTRUCTORS
	];
	if (!collection) {
		throw new Error(
			`Plugin storage collection "${COURSE_INSTRUCTORS}" is not declared in the descriptor.`,
		);
	}
	return collection as StorageCollection<CourseInstructor>;
}

/**
 * Look up the existing `(courseId, userId)` row, if any. Returns `undefined`
 * when no row exists. `limit: 1` keeps the query a point lookup.
 */
async function findExisting(
	ctx: PluginContext,
	courseId: string,
	userId: string,
): Promise<{ id: string; data: CourseInstructor } | undefined> {
	const collection = instructorsCollection(ctx);
	const result = await collection.query({ where: { courseId, userId }, limit: 1 });
	return result.items[0];
}

/**
 * Assign `userId` as an instructor (`lead` / `co` / `ta`) of `courseId`.
 *
 * - First call: creates a row, returns `ok(row)`.
 * - Repeat call with the same role: no-op, returns `ok(row)` for the existing
 *   row (idempotent per §24).
 * - Repeat call with a different role: overwrites the role on the existing
 *   row and returns `ok(row)`.
 *
 * Validation:
 *   - `courseId` and `userId` must be non-empty strings; empty inputs return
 *     `err(LEARN_FORBIDDEN, ...)`. The route layer does Zod validation first,
 *     but the engine guards belt-and-suspenders.
 */
export async function assign(
	ctx: PluginContext,
	courseId: string,
	userId: string,
	role: InstructorRole,
): Promise<Result<CourseInstructor>> {
	if (!courseId || !userId) {
		return err(LEARN_ERRORS.FORBIDDEN, "courseId and userId are required");
	}

	const collection = instructorsCollection(ctx);
	const existing = await findExisting(ctx, courseId, userId);

	if (existing) {
		// Idempotency: same-role re-assign is a no-op success. Different-role
		// re-assign updates the row in place — callers (admin UI, scripts) get
		// "promote co to lead" without an unassign + reassign dance.
		if (existing.data.role === role) {
			return ok(existing.data);
		}
		const updated: CourseInstructor = { ...existing.data, role };
		await collection.put(existing.id, updated);
		ctx.log.info("instructor role updated", {
			courseId,
			userId,
			role,
			previousRole: existing.data.role,
		});
		return ok(updated);
	}

	const id = `ci_${ulid()}`;
	const row: CourseInstructor = { courseId, userId, role };
	await collection.put(id, row);
	ctx.log.info("instructor assigned", { courseId, userId, role });
	return ok(row);
}

/**
 * Remove the `(courseId, userId)` row. Re-driving on a missing row is a
 * no-op success — matches the idempotency convention (§24) so the route
 * handler never branches on "already unassigned".
 */
export async function unassign(
	ctx: PluginContext,
	courseId: string,
	userId: string,
): Promise<Result<void>> {
	if (!courseId || !userId) {
		return err(LEARN_ERRORS.FORBIDDEN, "courseId and userId are required");
	}

	const existing = await findExisting(ctx, courseId, userId);
	if (!existing) {
		// Already gone — idempotent success, no log noise on the no-op path.
		return ok(undefined);
	}

	const collection = instructorsCollection(ctx);
	await collection.delete(existing.id);
	ctx.log.info("instructor unassigned", {
		courseId,
		userId,
		previousRole: existing.data.role,
	});
	return ok(undefined);
}

/**
 * List every instructor assigned to a course. Order is whatever the storage
 * backend returns (no `orderBy` here — the admin UI sorts client-side per
 * §16.3 wireframe).
 */
export async function listForCourse(
	ctx: PluginContext,
	courseId: string,
): Promise<Result<CourseInstructor[]>> {
	if (!courseId) {
		return err(LEARN_ERRORS.FORBIDDEN, "courseId is required");
	}
	const collection = instructorsCollection(ctx);
	const result = await collection.query({ where: { courseId } });
	return ok(result.items.map((row) => row.data));
}

/**
 * List every course this user instructs. Used by `instructor:courses`
 * (route owned by T15) and the dashboard "my courses" panel.
 */
export async function listForUser(
	ctx: PluginContext,
	userId: string,
): Promise<Result<CourseInstructor[]>> {
	if (!userId) {
		return err(LEARN_ERRORS.FORBIDDEN, "userId is required");
	}
	const collection = instructorsCollection(ctx);
	const result = await collection.query({ where: { userId } });
	return ok(result.items.map((row) => row.data));
}

/**
 * Full scan of `course_instructors`. Consumed by the admin `/instructors`
 * page (§16.9) which renders every assignment grouped by user. At v1 scale
 * the instructor roster is small (dozens, not thousands), so a single scan
 * beats paginating through courses client-side.
 */
export async function listAll(ctx: PluginContext): Promise<CourseInstructor[]> {
	const collection = instructorsCollection(ctx);
	const result = await collection.query({});
	return result.items.map((row) => row.data);
}

/**
 * Boolean predicate consumed by `authz.requireInstructor` (T03) and later
 * route handlers that gate on "is the caller an instructor of this course?".
 * Returns a raw boolean rather than a `Result<boolean>` because every call
 * site wants to branch immediately — wrapping in `Result` would be ceremony.
 *
 * Empty inputs return `false` (rather than throwing) so guards can compose:
 *   `if (!await isInstructorOf(ctx, userId, courseId)) return forbidden()`
 */
export async function isInstructorOf(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<boolean> {
	if (!userId || !courseId) return false;
	const existing = await findExisting(ctx, courseId, userId);
	return existing !== undefined;
}

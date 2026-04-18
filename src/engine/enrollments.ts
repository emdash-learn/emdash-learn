/**
 * Enrollments engine (T05 / §22 / §5.3 / §8.2).
 *
 * Owns the authoritative `enrollments` storage rows and the surrounding
 * business rules:
 *
 *   - `grant`  — creates an enrollment row for `(userId, courseId)` after
 *     validating that the course exists, enrollment is open (per
 *     `enrollment_open` + `enrollment_opens_at` / `enrollment_closes_at` from
 *     §5.1), and the user is not already enrolled. On success, emits
 *     `enrollment:created` (critical) so downstream handlers can fan out
 *     welcome email / instructor notify per §8.2.
 *   - `revoke` — flips `revokedAt` (+ optional `revokedReason`) on an existing
 *     row by `enrollmentId`. Emits `enrollment:revoked` on success.
 *   - `listByUser` / `listByCourse` — paginated reads against the
 *     `(userId,…)` / `(courseId,…)` indexes declared in the descriptor.
 *   - `isEnrolled` — point-lookup convenience used by other engine modules
 *     and `authz.requireEnrolled`.
 *
 * §8.3 atomicity: the engine writes the authoritative row first, then emits.
 * Handlers are idempotent (event-bus dedupes on `event.key`), so re-driving
 * an event after a partial failure is safe.
 *
 * Error taxonomy (§17.6):
 *   - `LEARN_ALREADY_ENROLLED` (409) — duplicate `(userId, courseId)`.
 *   - `LEARN_ENROLLMENT_CLOSED` (403) — `enrollment_open=false` or outside
 *     the open/close window. The check uses `Date.now()`, which tests pin via
 *     `tests/utils/time.ts::fakeNow`.
 *   - `LEARN_NOT_ENROLLED` (403/404) — `revoke` against a missing or already
 *     revoked row.
 *   - `LEARN_SETUP_INCOMPLETE` (409) — the `courses` collection isn't
 *     provisioned yet (the wizard hasn't run, or `ctx.content` is gated off).
 *
 * All writes go through the engine — routes never touch `ctx.storage` directly.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { ulid } from "emdash";

import { LEARN_ERRORS } from "../constants.js";
import type {
	Enrollment,
	EnrollmentSource,
} from "../types/storage.js";
import { emit } from "./event-bus.js";
import { err, ok, type Result } from "./result.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GrantInput {
	courseId: string;
	source: EnrollmentSource;
	cohortId?: string;
	orderId?: string;
}

export interface EnrollmentRecord {
	/** Storage row id. Generated as `enr_${ulid()}` so reads are sortable. */
	id: string;
	/** The persisted row data. */
	data: Enrollment;
}

export type ListStatus = "active" | "completed" | "all";

export interface ListOptions {
	status?: ListStatus;
	cursor?: string;
	limit?: number;
}

export interface PaginatedEnrollments {
	items: EnrollmentRecord[];
	cursor?: string;
	hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Narrow `ctx.storage.enrollments` out of the generic storage record.
 * The collection is declared in the plugin descriptor (`src/sandbox-entry.ts`),
 * so a missing key is a programmer error — surface it loudly rather than
 * silently degrading at request time.
 */
function enrollmentsStore(ctx: PluginContext): StorageCollection<Enrollment> {
	const store = (ctx.storage as Record<string, StorageCollection | undefined>).enrollments;
	if (!store) {
		throw new Error(
			"engine/enrollments: ctx.storage.enrollments is not declared on the descriptor.",
		);
	}
	return store as StorageCollection<Enrollment>;
}

/**
 * Resolve a course content item by id. Returns `null` if `ctx.content` is
 * unavailable (capability not granted) or the row doesn't exist. Callers map
 * `null` to `LEARN_SETUP_INCOMPLETE` since both shapes mean "we cannot
 * authoritatively confirm the course exists."
 */
async function getCourse(ctx: PluginContext, courseId: string) {
	if (!ctx.content) return null;
	return ctx.content.get("courses", courseId);
}

/**
 * Apply the §5.1 enrollment-window rules. Returns `null` when enrollment is
 * permitted, otherwise a `LEARN_ENROLLMENT_CLOSED` error.
 *
 * Window semantics:
 *   - `enrollment_open=false` is a hard close regardless of dates.
 *   - `enrollment_opens_at` (if set) is a lower bound; `enrollment_closes_at`
 *     (if set) is an exclusive upper bound. Missing bounds mean "no bound."
 *   - All comparisons use `Date.now()` so `fakeNow()` works in tests.
 */
function checkEnrollmentWindow(course: { data: unknown }): Result<never> | null {
	const data = course.data as Record<string, unknown>;
	const enrollmentOpen = data.enrollment_open;
	// emdash stores booleans as 0/1 in SQLite, so accept both shapes. Absent
	// field defaults to "open" (the fixture's defaultValue), not closed.
	if (enrollmentOpen === false || enrollmentOpen === 0) {
		return err(LEARN_ERRORS.ENROLLMENT_CLOSED, "Enrollment is closed for this course");
	}

	const now = Date.now();
	const opensAt = data.enrollment_opens_at;
	if (typeof opensAt === "string" && opensAt.length > 0) {
		const opens = Date.parse(opensAt);
		if (!Number.isNaN(opens) && now < opens) {
			return err(
				LEARN_ERRORS.ENROLLMENT_CLOSED,
				`Enrollment opens at ${opensAt}`,
			);
		}
	}

	const closesAt = data.enrollment_closes_at;
	if (typeof closesAt === "string" && closesAt.length > 0) {
		const closes = Date.parse(closesAt);
		if (!Number.isNaN(closes) && now >= closes) {
			return err(
				LEARN_ERRORS.ENROLLMENT_CLOSED,
				`Enrollment closed at ${closesAt}`,
			);
		}
	}

	return null;
}

/**
 * Locate the enrollment for `(userId, courseId)` regardless of revoked
 * state. Returns the storage record (id + data) or `null`. Uses the
 * `(userId, courseId)` unique index from `src/sandbox-entry.ts`.
 */
async function findEnrollment(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<EnrollmentRecord | null> {
	const result = await enrollmentsStore(ctx).query({
		where: { userId, courseId },
		limit: 1,
	});
	const row = result.items[0];
	return row ? { id: row.id, data: row.data } : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Grant a new enrollment. Validates course existence + enrollment window,
 * dedupes against the unique `(userId, courseId)` index, persists the row,
 * then emits `enrollment:created` (critical).
 *
 * Cohort-capacity enforcement (D43, §6.3) lives on `engine/cohorts.ts`'s
 * `addMember`; `grant` only stamps `cohortId` on the enrollment for theme
 * filtering. Coupling them in v1 would force a cohort lookup on every
 * enrollment write — not worth it at v1 scale.
 */
export async function grant(
	ctx: PluginContext,
	userId: string,
	input: GrantInput,
): Promise<Result<Enrollment>> {
	if (!userId) {
		return err(LEARN_ERRORS.UNAUTHENTICATED, "Authentication required");
	}

	const course = await getCourse(ctx, input.courseId);
	if (!course) {
		return err(
			LEARN_ERRORS.SETUP_INCOMPLETE,
			`Course ${input.courseId} not found (or content access not granted)`,
		);
	}

	const closed = checkEnrollmentWindow(course);
	if (closed) return closed;

	const existing = await findEnrollment(ctx, userId, input.courseId);
	if (existing && !existing.data.revokedAt) {
		return err(
			LEARN_ERRORS.ALREADY_ENROLLED,
			`User ${userId} is already enrolled in course ${input.courseId}`,
		);
	}

	// Re-enrollment after revocation: clear `revokedAt`/`revokedReason` and
	// stamp a fresh `enrolledAt` so downstream drip math (§22 engine/drip)
	// resets from "now". Keep the same row id so foreign references in
	// `progress` / `certificates` stay coherent.
	const enrolledAt = new Date().toISOString();
	const id = existing?.id ?? `enr_${ulid()}`;
	const data: Enrollment = {
		userId,
		courseId: input.courseId,
		enrolledAt,
		source: input.source,
	};
	if (input.orderId !== undefined) data.orderId = input.orderId;
	if (input.cohortId !== undefined) data.cohortId = input.cohortId;

	await enrollmentsStore(ctx).put(id, data);

	// §8.3: row is the source of truth, emit second. `critical: true` so a
	// downstream sync handler failure surfaces to the route boundary.
	await emit(
		{
			name: "enrollment:created",
			key: `enroll:${id}`,
			data,
			critical: true,
		},
		ctx,
	);

	return ok(data);
}

/**
 * Revoke an existing enrollment by row id. Returns `LEARN_NOT_ENROLLED` if
 * the row is missing or already revoked. Emits `enrollment:revoked` on
 * success — the email handler is best-effort per §8.2 so the event is not
 * marked `critical`.
 */
export async function revoke(
	ctx: PluginContext,
	enrollmentId: string,
	reason?: string,
): Promise<Result<Enrollment>> {
	const store = enrollmentsStore(ctx);
	const existing = await store.get(enrollmentId);
	if (!existing) {
		return err(
			LEARN_ERRORS.NOT_ENROLLED,
			`Enrollment ${enrollmentId} not found`,
		);
	}
	if (existing.revokedAt) {
		return err(
			LEARN_ERRORS.NOT_ENROLLED,
			`Enrollment ${enrollmentId} is already revoked`,
		);
	}

	const revokedAt = new Date().toISOString();
	const updated: Enrollment = {
		...existing,
		revokedAt,
	};
	if (reason !== undefined) updated.revokedReason = reason;
	await store.put(enrollmentId, updated);

	const eventData: { enrollmentId: string; reason?: string } = { enrollmentId };
	if (reason !== undefined) eventData.reason = reason;
	await emit(
		{
			name: "enrollment:revoked",
			key: `revoke:${enrollmentId}`,
			data: eventData,
		},
		ctx,
	);

	return ok(updated);
}

/**
 * Look up a single enrollment row by storage id. Convenience for routes that
 * already hold an `enrollmentId` (e.g. the `unenroll` route's ownership
 * check). Returns `null` when the row is absent.
 */
export async function getById(
	ctx: PluginContext,
	enrollmentId: string,
): Promise<Result<EnrollmentRecord>> {
	const data = await enrollmentsStore(ctx).get(enrollmentId);
	if (!data) {
		return err(LEARN_ERRORS.NOT_ENROLLED, `Enrollment ${enrollmentId} not found`);
	}
	return ok({ id: enrollmentId, data });
}

/**
 * List enrollments for a user, applying the §6.1 `status` filter:
 *   - `active`    — `revokedAt` unset and `completedAt` unset.
 *   - `completed` — `completedAt` set.
 *   - `all`       — every row, including revoked.
 *   - undefined   — defaults to `active` to match `my-learning` UX.
 *
 * Pagination uses the storage layer's cursor (the `(userId, …)` index keeps
 * scans bounded). Filtering happens in-process because the storage `where`
 * clause does not support "field present/absent" predicates.
 */
export async function listByUser(
	ctx: PluginContext,
	userId: string,
	opts: ListOptions = {},
): Promise<Result<PaginatedEnrollments>> {
	const status = opts.status ?? "active";
	const page = await enrollmentsStore(ctx).query({
		where: { userId },
		limit: opts.limit,
		cursor: opts.cursor,
	});

	const items = page.items
		.filter((row) => matchesStatus(row.data, status))
		.map((row) => ({ id: row.id, data: row.data }));

	const result: PaginatedEnrollments = { items, hasMore: page.hasMore };
	if (page.cursor !== undefined) result.cursor = page.cursor;
	return ok(result);
}

/**
 * List enrollments for a course. Same filter semantics as `listByUser`.
 * Used by instructor analytics routes (T15) and the cohort/instructor admin
 * surfaces; staying inside the engine keeps the storage shape behind one wall.
 */
export async function listByCourse(
	ctx: PluginContext,
	courseId: string,
	opts: ListOptions = {},
): Promise<Result<PaginatedEnrollments>> {
	const status = opts.status ?? "active";
	const page = await enrollmentsStore(ctx).query({
		where: { courseId },
		limit: opts.limit,
		cursor: opts.cursor,
	});

	const items = page.items
		.filter((row) => matchesStatus(row.data, status))
		.map((row) => ({ id: row.id, data: row.data }));

	const result: PaginatedEnrollments = { items, hasMore: page.hasMore };
	if (page.cursor !== undefined) result.cursor = page.cursor;
	return ok(result);
}

/**
 * Boolean point-check: is `userId` actively enrolled in `courseId`?
 * Used by `authz.requireEnrolled` in production paths and by route
 * pre-checks elsewhere in the engine.
 */
export async function isEnrolled(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<boolean> {
	const row = await findEnrollment(ctx, userId, courseId);
	if (!row) return false;
	return !row.data.revokedAt;
}

function matchesStatus(row: Enrollment, status: ListStatus): boolean {
	if (status === "all") return true;
	if (status === "completed") return Boolean(row.completedAt);
	// "active" — not revoked AND not completed.
	return !row.revokedAt && !row.completedAt;
}

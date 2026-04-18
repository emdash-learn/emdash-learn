/**
 * Unit tests for `src/authz.ts` (T03). Each helper has an allow, deny, and
 * no-user path. Tests run against stub contexts because T04's
 * `createTestPluginCtx` is not available yet; the stub surface is intentionally
 * narrow — just the storage collections and `user` field the helpers touch.
 */

import { describe, expect, it } from "vitest";

import {
	Role,
	requireEnrolled,
	requireInstructor,
	requireOwner,
	requireRole,
	type AuthContext,
} from "../../src/authz.js";
import { LEARN_ERRORS } from "../../src/constants.js";
import type { CourseInstructor, Enrollment } from "../../src/types/storage.js";

// -----------------------------------------------------------------------------
// Stub helpers — a minimal `PluginContext`-shaped object that satisfies the
// authz helpers. When T04 lands, real tests should migrate to
// `createTestPluginCtx()`.
// -----------------------------------------------------------------------------

type StubUser = AuthContext["user"];

interface StubRow<T> {
	id: string;
	data: T;
}

function stubCollection<T>(rows: Array<StubRow<T>>): {
	query: (opts?: {
		where?: Record<string, unknown>;
		limit?: number;
	}) => Promise<{ items: Array<StubRow<T>>; hasMore: boolean }>;
} {
	return {
		async query(opts) {
			const where = opts?.where ?? {};
			const filtered = rows.filter((row) => {
				const data = row.data as Record<string, unknown>;
				return Object.entries(where).every(([key, val]) => data[key] === val);
			});
			const limited = typeof opts?.limit === "number" ? filtered.slice(0, opts.limit) : filtered;
			return { items: limited, hasMore: limited.length < filtered.length };
		},
	};
}

function stubContext(opts: {
	user?: StubUser;
	enrollments?: Array<StubRow<Enrollment>>;
	courseInstructors?: Array<StubRow<CourseInstructor>>;
}): AuthContext {
	const ctx = {
		user: opts.user ?? null,
		storage: {
			enrollments: stubCollection(opts.enrollments ?? []),
			course_instructors: stubCollection(opts.courseInstructors ?? []),
		},
	} as unknown as AuthContext;
	return ctx;
}

const subscriber: NonNullable<StubUser> = {
	id: "user-sub",
	email: "sub@example.com",
	name: "Sub",
	role: Role.SUBSCRIBER,
	createdAt: "2026-01-01T00:00:00.000Z",
};

const editor: NonNullable<StubUser> = {
	id: "user-edit",
	email: "edit@example.com",
	name: "Edit",
	role: Role.EDITOR,
	createdAt: "2026-01-01T00:00:00.000Z",
};

// -----------------------------------------------------------------------------
// requireRole
// -----------------------------------------------------------------------------

describe("requireRole", () => {
	it("allows a user whose role meets the minimum", () => {
		const ctx = stubContext({ user: editor });
		const result = requireRole(ctx, Role.EDITOR);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data).toBe(editor);
	});

	it("allows a user whose role exceeds the minimum", () => {
		const ctx = stubContext({ user: editor });
		const result = requireRole(ctx, Role.SUBSCRIBER);
		expect(result.ok).toBe(true);
	});

	it("denies a user whose role is below the minimum", () => {
		const ctx = stubContext({ user: subscriber });
		const result = requireRole(ctx, Role.EDITOR);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(LEARN_ERRORS.FORBIDDEN);
	});

	it("returns UNAUTHENTICATED when no user is on the context", () => {
		const ctx = stubContext({ user: null });
		const result = requireRole(ctx, Role.SUBSCRIBER);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(LEARN_ERRORS.UNAUTHENTICATED);
	});
});

// -----------------------------------------------------------------------------
// requireInstructor
// -----------------------------------------------------------------------------

describe("requireInstructor", () => {
	const instructorRow: StubRow<CourseInstructor> = {
		id: "ci-1",
		data: { courseId: "course-1", userId: "user-edit", role: "lead" },
	};

	it("allows a user with a matching course_instructors row", async () => {
		const ctx = stubContext({ courseInstructors: [instructorRow] });
		const result = await requireInstructor(ctx, "user-edit", "course-1");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data).toEqual(instructorRow.data);
	});

	it("denies a user with no matching course_instructors row", async () => {
		const ctx = stubContext({ courseInstructors: [instructorRow] });
		const result = await requireInstructor(ctx, "user-other", "course-1");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(LEARN_ERRORS.NOT_INSTRUCTOR);
	});

	it("denies when the row exists but for a different course", async () => {
		const ctx = stubContext({ courseInstructors: [instructorRow] });
		const result = await requireInstructor(ctx, "user-edit", "course-other");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(LEARN_ERRORS.NOT_INSTRUCTOR);
	});

	it("returns UNAUTHENTICATED when userId is empty", async () => {
		const ctx = stubContext({ courseInstructors: [instructorRow] });
		const result = await requireInstructor(ctx, "", "course-1");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(LEARN_ERRORS.UNAUTHENTICATED);
	});
});

// -----------------------------------------------------------------------------
// requireEnrolled
// -----------------------------------------------------------------------------

describe("requireEnrolled", () => {
	const activeEnrollment: StubRow<Enrollment> = {
		id: "e-active",
		data: {
			userId: "user-sub",
			courseId: "course-1",
			enrolledAt: "2026-02-01T00:00:00.000Z",
			source: "free",
		},
	};

	const revokedEnrollment: StubRow<Enrollment> = {
		id: "e-revoked",
		data: {
			userId: "user-sub",
			courseId: "course-2",
			enrolledAt: "2026-02-01T00:00:00.000Z",
			source: "free",
			revokedAt: "2026-03-01T00:00:00.000Z",
			revokedReason: "refund",
		},
	};

	it("allows an enrolled user", async () => {
		const ctx = stubContext({ enrollments: [activeEnrollment] });
		const result = await requireEnrolled(ctx, "user-sub", "course-1");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data).toEqual(activeEnrollment.data);
	});

	it("denies a user with no enrollment row", async () => {
		const ctx = stubContext({ enrollments: [] });
		const result = await requireEnrolled(ctx, "user-sub", "course-1");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(LEARN_ERRORS.NOT_ENROLLED);
	});

	it("treats revoked enrollments as not-enrolled", async () => {
		const ctx = stubContext({ enrollments: [revokedEnrollment] });
		const result = await requireEnrolled(ctx, "user-sub", "course-2");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(LEARN_ERRORS.NOT_ENROLLED);
	});

	it("returns UNAUTHENTICATED when userId is empty", async () => {
		const ctx = stubContext({ enrollments: [activeEnrollment] });
		const result = await requireEnrolled(ctx, "", "course-1");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(LEARN_ERRORS.UNAUTHENTICATED);
	});
});

// -----------------------------------------------------------------------------
// requireOwner
// -----------------------------------------------------------------------------

describe("requireOwner", () => {
	const resource = { id: "progress-1", userId: "user-sub", lessonId: "lesson-1" };

	it("allows the user whose id matches the resource's userId", () => {
		const ctx = stubContext({ user: subscriber });
		const result = requireOwner(ctx, "user-sub", resource);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.data).toBe(resource);
	});

	it("denies a user whose id does not match the resource's userId", () => {
		const ctx = stubContext({ user: subscriber });
		const result = requireOwner(ctx, "user-other", resource);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(LEARN_ERRORS.FORBIDDEN);
	});

	it("returns UNAUTHENTICATED when userId is empty", () => {
		const ctx = stubContext({ user: null });
		const result = requireOwner(ctx, "", resource);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(LEARN_ERRORS.UNAUTHENTICATED);
	});
});

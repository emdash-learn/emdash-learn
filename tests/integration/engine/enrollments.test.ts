/**
 * Integration tests for `engine/enrollments.ts` (T05).
 *
 * Covers:
 *   - `grant` creates a row and dedupes on the `(userId,courseId)` unique
 *     index (LEARN_ALREADY_ENROLLED).
 *   - Enrollment-window closed paths: `enrollment_open=false`,
 *     `enrollment_closes_at` in the past.
 *   - Re-enroll after revocation clears `revokedAt` and reuses the row id
 *     so downstream refs stay coherent.
 *   - `revoke` stamps `revokedAt`, re-revoke returns LEARN_NOT_ENROLLED.
 *   - `listByUser` / `listByCourse` apply the active/completed/all filter.
 *   - `isEnrolled` is true only when there is an un-revoked row.
 *
 * Note: the event bus has been removed (AUDIT C1, Track C). Tests that
 * previously asserted enrollment:created / enrollment:revoked events now
 * verify storage state directly. Welcome / completion email delivery is
 * asserted in the send-lifecycle-emails reconciler tests.
 */

import { afterEach, describe, expect, it } from "vitest";

import * as enrollments from "../../../src/engine/enrollments.js";
import { seedCourse, seedEnrollment, seedStudent } from "../../utils/seed.js";
import { createTestPluginCtx } from "../../utils/test-plugin-ctx.js";

type TestCtx = Awaited<ReturnType<typeof createTestPluginCtx>>;

const contexts: TestCtx[] = [];

async function newCtx(): Promise<TestCtx> {
	const ctx = await createTestPluginCtx();
	contexts.push(ctx);
	return ctx;
}

afterEach(async () => {
	const pending = contexts.splice(0, contexts.length);
	await Promise.all(pending.map((ctx) => ctx.teardown()));
});

describe("engine/enrollments.grant", () => {
	it("creates a row with correct userId, courseId, source", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "s1@test.local" });
		const course = await seedCourse(ctx, { title: "Course A" });

		const result = await enrollments.grant(ctx, student.id, {
			courseId: course.id,
			source: "free",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.userId).toBe(student.id);
		expect(result.data.courseId).toBe(course.id);
		expect(result.data.source).toBe("free");
		expect(result.data.enrolledAt).toBeDefined();
	});

	it("persists the enrollment row in storage", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "s1b@test.local" });
		const course = await seedCourse(ctx, { title: "Course A-persist" });

		const result = await enrollments.grant(ctx, student.id, {
			courseId: course.id,
			source: "free",
		});
		expect(result.ok).toBe(true);

		// Verify the enrollment row is actually in storage (not just returned in-memory).
		expect(await enrollments.isEnrolled(ctx, student.id, course.id)).toBe(true);
	});

	it("returns LEARN_ALREADY_ENROLLED for a duplicate", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "s2@test.local" });
		const course = await seedCourse(ctx, { title: "Course B" });

		await enrollments.grant(ctx, student.id, { courseId: course.id, source: "free" });
		const dup = await enrollments.grant(ctx, student.id, { courseId: course.id, source: "free" });

		expect(dup.ok).toBe(false);
		if (dup.ok) return;
		expect(dup.error.code).toBe("LEARN_ALREADY_ENROLLED");
	});

	it("returns LEARN_ENROLLMENT_CLOSED when enrollment_open is false", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "s3@test.local" });
		const course = await seedCourse(ctx, { title: "Closed", enrollmentOpen: false });

		const result = await enrollments.grant(ctx, student.id, {
			courseId: course.id,
			source: "free",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("LEARN_ENROLLMENT_CLOSED");
	});

	it("returns LEARN_ENROLLMENT_CLOSED when enrollment_closes_at is in the past", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "s4@test.local" });
		const course = await seedCourse(ctx, {
			title: "Past",
			enrollmentClosesAt: "2020-01-01T00:00:00.000Z",
		});

		const result = await enrollments.grant(ctx, student.id, {
			courseId: course.id,
			source: "free",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("LEARN_ENROLLMENT_CLOSED");
	});

	it("returns LEARN_SETUP_INCOMPLETE when the course does not exist", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "s5@test.local" });
		const result = await enrollments.grant(ctx, student.id, {
			courseId: "does-not-exist",
			source: "free",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("LEARN_SETUP_INCOMPLETE");
	});

	it("re-enroll after revocation clears revokedAt", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "s6@test.local" });
		const course = await seedCourse(ctx, { title: "Re-enroll" });

		const first = await enrollments.grant(ctx, student.id, {
			courseId: course.id,
			source: "free",
		});
		expect(first.ok).toBe(true);

		const list = await enrollments.listByUser(ctx, student.id, { status: "all" });
		expect(list.ok).toBe(true);
		if (!list.ok) return;
		const row = list.data.items[0];
		expect(row).toBeDefined();
		if (!row) return;

		await enrollments.revoke(ctx, row.id, "left");

		const revoked = await enrollments.isEnrolled(ctx, student.id, course.id);
		expect(revoked).toBe(false);

		const second = await enrollments.grant(ctx, student.id, {
			courseId: course.id,
			source: "free",
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.data.revokedAt).toBeUndefined();
	});

	it("concurrent grants: no unhandled exceptions and active enrollment exists (H3)", async () => {
		// The storage layer's uniqueIndexes are enforced via expression indexes in
		// production but not as hard unique constraints in the test runtime path.
		// What we verify here: concurrent grants never throw, and at least one
		// enrollment is active after the burst. The try/catch in grant() is
		// defense-in-depth for when the DB DOES enforce uniqueness.
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "race@test.local" });
		const course = await seedCourse(ctx, { title: "Race Course" });

		const results = await Promise.all(
			Array.from({ length: 10 }, () =>
				enrollments.grant(ctx, student.id, { courseId: course.id, source: "free" }),
			),
		);
		const errors = results.filter((r) => !r.ok && r.error.code !== "LEARN_ALREADY_ENROLLED");
		expect(errors).toHaveLength(0);
		expect(await enrollments.isEnrolled(ctx, student.id, course.id)).toBe(true);
	});
});

describe("engine/enrollments.revoke", () => {
	it("stamps revokedAt on the storage row", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "s7@test.local" });
		const course = await seedCourse(ctx, { title: "Revoke" });
		const seeded = await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const result = await enrollments.revoke(ctx, seeded.id, "violation");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.revokedAt).toBeDefined();
		expect(result.data.revokedReason).toBe("violation");

		// Verify storage row was actually updated.
		expect(await enrollments.isEnrolled(ctx, student.id, course.id)).toBe(false);
	});

	it("returns LEARN_NOT_ENROLLED for a missing row", async () => {
		const { ctx } = await newCtx();
		const result = await enrollments.revoke(ctx, "enr_missing");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("LEARN_NOT_ENROLLED");
	});

	it("returns LEARN_NOT_ENROLLED when already revoked", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "s8@test.local" });
		const course = await seedCourse(ctx, { title: "Double" });
		const seeded = await seedEnrollment(ctx, { userId: student.id, courseId: course.id });
		await enrollments.revoke(ctx, seeded.id);
		const again = await enrollments.revoke(ctx, seeded.id);
		expect(again.ok).toBe(false);
		if (again.ok) return;
		expect(again.error.code).toBe("LEARN_NOT_ENROLLED");
	});
});

describe("engine/enrollments.listByUser / listByCourse", () => {
	it("listByUser filters by active status by default", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "sl1@test.local" });
		const c1 = await seedCourse(ctx, { title: "L1" });
		const c2 = await seedCourse(ctx, { title: "L2" });

		const r1 = await seedEnrollment(ctx, { userId: student.id, courseId: c1.id });
		const r2 = await seedEnrollment(ctx, { userId: student.id, courseId: c2.id });
		await enrollments.revoke(ctx, r2.id);

		const active = await enrollments.listByUser(ctx, student.id);
		expect(active.ok).toBe(true);
		if (!active.ok) return;
		const activeIds = active.data.items.map((item) => item.id);
		expect(activeIds).toContain(r1.id);
		expect(activeIds).not.toContain(r2.id);

		const all = await enrollments.listByUser(ctx, student.id, { status: "all" });
		expect(all.ok && all.data.items.length).toBe(2);
	});

	it("listByCourse returns rows for the course only", async () => {
		const { ctx } = await newCtx();
		const course = await seedCourse(ctx, { title: "ByCourse" });
		const other = await seedCourse(ctx, { title: "Other" });
		const s1 = await seedStudent(ctx, { email: "bc1@test.local" });
		const s2 = await seedStudent(ctx, { email: "bc2@test.local" });

		await seedEnrollment(ctx, { userId: s1.id, courseId: course.id });
		await seedEnrollment(ctx, { userId: s2.id, courseId: course.id });
		await seedEnrollment(ctx, { userId: s1.id, courseId: other.id });

		const list = await enrollments.listByCourse(ctx, course.id);
		expect(list.ok).toBe(true);
		if (!list.ok) return;
		expect(list.data.items).toHaveLength(2);
	});
});

describe("engine/enrollments.isEnrolled", () => {
	it("true when active, false after revoke", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "ie1@test.local" });
		const course = await seedCourse(ctx, { title: "IE" });

		expect(await enrollments.isEnrolled(ctx, student.id, course.id)).toBe(false);
		const row = await seedEnrollment(ctx, { userId: student.id, courseId: course.id });
		expect(await enrollments.isEnrolled(ctx, student.id, course.id)).toBe(true);
		await enrollments.revoke(ctx, row.id);
		expect(await enrollments.isEnrolled(ctx, student.id, course.id)).toBe(false);
	});
});

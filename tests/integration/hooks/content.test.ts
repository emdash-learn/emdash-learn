/**
 * Integration tests for `hooks/content.ts` (T12).
 *
 * Covers the `content:beforeDelete` deletion guards from §21 Phase 5:
 *   - `courses`: refuse while any non-revoked enrollment references the
 *     course; allow when there are no enrollments or every enrollment is
 *     revoked.
 *   - `lessons`: refuse as soon as any `progress` row references the
 *     lesson; allow when no rows reference it.
 *   - Other collections: always pass through (return `undefined`).
 *
 * The handler is called directly — the orchestrator wires it into the
 * plugin descriptor post-merge, so these tests intentionally do not go
 * through the hook pipeline.
 */

import { afterEach, describe, expect, it } from "vitest";

import { contentBeforeDelete } from "../../../src/hooks/content.js";
import {
	seedCourse,
	seedEnrollment,
	seedLesson,
	seedProgress,
	seedStudent,
} from "../../utils/seed.js";
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

describe("hooks/content.contentBeforeDelete — courses", () => {
	it("refuses delete when an active enrollment exists", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "c1@test.local" });
		const course = await seedCourse(ctx, { title: "Active Course" });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const result = await contentBeforeDelete(
			{ id: course.id, collection: "courses", permanent: true },
			ctx,
		);
		expect(result).toBe(false);
	});

	it("allows delete when no enrollments", async () => {
		const { ctx } = await newCtx();
		const course = await seedCourse(ctx, { title: "Empty Course" });

		const result = await contentBeforeDelete(
			{ id: course.id, collection: "courses", permanent: true },
			ctx,
		);
		expect(result).toBeUndefined();
	});

	it("allows delete when all enrollments are revoked", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "c3@test.local" });
		const course = await seedCourse(ctx, { title: "All-Revoked Course" });
		const enrollment = await seedEnrollment(ctx, {
			userId: student.id,
			courseId: course.id,
		});

		// Flip `revokedAt` directly on the storage row. Going through
		// `engine/enrollments.revoke` would pull in the event bus, which is
		// extra surface for a hook-level test; the write shape is the thing
		// the hook inspects.
		const store = (ctx.storage as Record<string, { put(id: string, data: unknown): Promise<void> }>)
			.enrollments;
		await store.put(enrollment.id, {
			userId: enrollment.userId,
			courseId: enrollment.courseId,
			enrolledAt: enrollment.enrolledAt,
			source: enrollment.source,
			revokedAt: new Date().toISOString(),
			revokedReason: "test",
		});

		const result = await contentBeforeDelete(
			{ id: course.id, collection: "courses", permanent: true },
			ctx,
		);
		expect(result).toBeUndefined();
	});
});

describe("hooks/content.contentBeforeDelete — lessons", () => {
	it("refuses delete when any progress row references it", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "l1@test.local" });
		const course = await seedCourse(ctx, { title: "Course w/ Progress" });
		const lesson = await seedLesson(ctx, { courseId: course.id, title: "L1" });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });
		await seedProgress(ctx, {
			userId: student.id,
			courseId: course.id,
			lessonId: lesson.id,
			percentComplete: 50,
		});

		const result = await contentBeforeDelete(
			{ id: lesson.id, collection: "lessons", permanent: true },
			ctx,
		);
		expect(result).toBe(false);
	});

	it("allows delete when no progress rows", async () => {
		const { ctx } = await newCtx();
		const course = await seedCourse(ctx, { title: "Course w/o Progress" });
		const lesson = await seedLesson(ctx, { courseId: course.id, title: "L2" });

		const result = await contentBeforeDelete(
			{ id: lesson.id, collection: "lessons", permanent: true },
			ctx,
		);
		expect(result).toBeUndefined();
	});
});

describe("hooks/content.contentBeforeDelete — other collections", () => {
	it("always allows delete for non-owned collections", async () => {
		const { ctx } = await newCtx();

		const result = await contentBeforeDelete(
			{ id: "cmt_abc123", collection: "comments", permanent: true },
			ctx,
		);
		expect(result).toBeUndefined();
	});
});

/**
 * Integration tests for the course_content_index projection (AUDIT C3).
 *
 * Covers:
 *   - Seeding a lesson via publishContent populates a projection row and
 *     makes listLessonsForCourse return the lesson.
 *   - Deleting a lesson removes the projection row; listLessonsForCourse
 *     no longer returns the lesson.
 *   - The backfill reconciler seeds the projection from scratch and is
 *     idempotent on a second run.
 */

import { afterEach, describe, expect, it } from "vitest";

import * as curriculum from "../../../src/engine/curriculum.js";
import { backfillContentIndexReconciler } from "../../../src/reconcilers/backfill-content-index.js";
import type { CourseContentIndexRow } from "../../../src/types/storage.js";
import type { StorageCollection } from "emdash";
import {
	deleteContent,
	publishContent,
	seedCourse,
	seedEnrollment,
	seedLesson,
	seedStudent,
	seedTopic,
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

function indexStore(ctx: TestCtx["ctx"]): StorageCollection<CourseContentIndexRow> {
	return (ctx.storage as Record<string, StorageCollection<CourseContentIndexRow>>)[
		"course_content_index"
	];
}

// ---------------------------------------------------------------------------
// Projection sync via content:afterSave hook
// ---------------------------------------------------------------------------

describe("course_content_index projection — lesson lifecycle", () => {
	it("projection row is created when a lesson is published", async () => {
		const { ctx } = await newCtx();
		const course = await seedCourse(ctx, { title: "ProjTest" });
		const lesson = await seedLesson(ctx, { courseId: course.id, order: 0, title: "L1" });
		await publishContent(ctx, "lessons", lesson.id);

		// Verify projection row exists.
		const store = indexStore(ctx);
		const rows = await store.query({ where: { courseId: course.id, stepType: "lesson" } });
		expect(rows.items).toHaveLength(1);
		expect(rows.items[0]?.data.stepId).toBe(lesson.id);
		expect(rows.items[0]?.data.stepType).toBe("lesson");
		expect(rows.items[0]?.data.courseId).toBe(course.id);
	});

	it("listLessonsForCourse returns the lesson via the projection", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "proj1@test.local" });
		const course = await seedCourse(ctx, { title: "ProjForUser" });
		await publishContent(ctx, "courses", course.id);
		const lesson = await seedLesson(ctx, { courseId: course.id, order: 0, title: "Via Index" });
		await publishContent(ctx, "lessons", lesson.id);
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const result = await curriculum.forUser(ctx, student.id, course.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.map((l) => l.id)).toContain(lesson.id);
	});

	it("projection row is removed and lesson disappears when the lesson is deleted", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "proj2@test.local" });
		const course = await seedCourse(ctx, { title: "ProjDelete" });
		await publishContent(ctx, "courses", course.id);
		const lesson = await seedLesson(ctx, { courseId: course.id, order: 0, title: "Gone" });
		await publishContent(ctx, "lessons", lesson.id);
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		// Confirm the lesson appears before deletion.
		const before = await curriculum.forUser(ctx, student.id, course.id);
		expect(before.ok).toBe(true);
		if (!before.ok) return;
		expect(before.data.map((l) => l.id)).toContain(lesson.id);

		// Delete the lesson and fire the afterDelete hook.
		await deleteContent(ctx, "lessons", lesson.id);

		// Projection row should be gone.
		const store = indexStore(ctx);
		const rows = await store.query({ where: { courseId: course.id, stepType: "lesson" } });
		expect(rows.items).toHaveLength(0);

		// listLessonsForCourse should now return empty.
		const after = await curriculum.forUser(ctx, student.id, course.id);
		expect(after.ok).toBe(true);
		if (!after.ok) return;
		expect(after.data).toHaveLength(0);
	});
});

describe("course_content_index projection — topic lifecycle", () => {
	it("topic projection row is created and queryable by lessonId", async () => {
		const { ctx } = await newCtx();
		const course = await seedCourse(ctx, { title: "TopicProj" });
		const lesson = await seedLesson(ctx, { courseId: course.id, order: 0 });
		await publishContent(ctx, "lessons", lesson.id);
		const topic = await seedTopic(ctx, {
			courseId: course.id,
			lessonId: lesson.id,
			order: 0,
			title: "T1",
		});
		await publishContent(ctx, "topics", topic.id);

		const store = indexStore(ctx);
		const topicRows = await store.query({
			where: { courseId: course.id, stepType: "topic" },
		});
		expect(topicRows.items).toHaveLength(1);
		expect(topicRows.items[0]?.data.lessonId).toBe(lesson.id);
		expect(topicRows.items[0]?.data.stepId).toBe(topic.id);
	});
});

// ---------------------------------------------------------------------------
// Backfill reconciler
// ---------------------------------------------------------------------------

describe("backfill-content-index reconciler", () => {
	it("seeds the projection from existing published lessons and topics", async () => {
		const { ctx } = await newCtx();
		const course = await seedCourse(ctx, { title: "Backfill" });
		// Publish two lessons and one topic without going through the hook
		// (simulate an older install where the projection is empty).
		const lesson1 = await seedLesson(ctx, { courseId: course.id, order: 0, title: "L1" });
		const lesson2 = await seedLesson(ctx, { courseId: course.id, order: 1, title: "L2" });
		const topic = await seedTopic(ctx, {
			courseId: course.id,
			lessonId: lesson1.id,
			order: 0,
			title: "T1",
		});

		// Publish via raw handleContentPublish (no hook, so projection stays empty).
		// We achieve this by publishing via seed.ts but then clearing the projection
		// manually to simulate a pre-index install.
		await publishContent(ctx, "lessons", lesson1.id);
		await publishContent(ctx, "lessons", lesson2.id);
		await publishContent(ctx, "topics", topic.id);

		// Clear the projection to simulate empty state.
		const store = indexStore(ctx);
		const beforeClear = await store.query({ where: { courseId: course.id } });
		for (const row of beforeClear.items) {
			await store.delete(row.id);
		}
		const afterClear = await store.query({ where: { courseId: course.id } });
		expect(afterClear.items).toHaveLength(0);

		// Run the backfill reconciler.
		const result = await backfillContentIndexReconciler(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.lessonsUpserted).toBeGreaterThanOrEqual(2);
		expect(result.data.topicsUpserted).toBeGreaterThanOrEqual(1);
		expect(result.data.errors).toBe(0);

		// Projection rows should now be populated.
		const lessonRows = await store.query({
			where: { courseId: course.id, stepType: "lesson" },
		});
		expect(lessonRows.items).toHaveLength(2);

		const topicRows = await store.query({
			where: { courseId: course.id, stepType: "topic" },
		});
		expect(topicRows.items).toHaveLength(1);
	});

	it("is idempotent — a second run does not duplicate rows", async () => {
		const { ctx } = await newCtx();
		const course = await seedCourse(ctx, { title: "BackfillIdem" });
		const lesson = await seedLesson(ctx, { courseId: course.id, order: 0 });
		await publishContent(ctx, "lessons", lesson.id);

		// First run — seeds the projection.
		const first = await backfillContentIndexReconciler(ctx);
		expect(first.ok).toBe(true);

		// Second run — should be a no-op (same rows).
		const second = await backfillContentIndexReconciler(ctx);
		expect(second.ok).toBe(true);

		const store = indexStore(ctx);
		const rows = await store.query({ where: { courseId: course.id, stepType: "lesson" } });
		// Must still be exactly 1 row, not 2.
		expect(rows.items).toHaveLength(1);
		expect(rows.items[0]?.data.stepId).toBe(lesson.id);
	});
});

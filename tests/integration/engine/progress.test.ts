/**
 * Integration tests for `engine/progress.ts` (T06).
 *
 * Covers:
 *   - `tick` upserts the progress row and auto-completes when
 *     `percentComplete >= 90` (§8.2, T06 acceptance).
 *   - `tick` is monotonic on `percentComplete` (never regresses).
 *   - `tick` gates on enrollment — `LEARN_NOT_ENROLLED` otherwise.
 *   - `markLessonComplete` emits `lesson:completed`, then evaluates the
 *     course and emits `course:completed` + stamps `enrollments.completedAt`
 *     when every published lesson is done.
 *   - Event-bus idempotency: re-crossing the 90% threshold does not re-fire
 *     handlers for the same `(userId, lessonId)` key.
 */

import { afterEach, describe, expect, it } from "vitest";
import { handleContentPublish } from "emdash";

import type { CourseCompleted, LessonCompleted } from "../../../src/types/engine.js";
import * as eventBus from "../../../src/engine/event-bus.js";
import * as progress from "../../../src/engine/progress.js";
import { seedCourse, seedEnrollment, seedLesson, seedStudent } from "../../utils/seed.js";
import { createTestPluginCtx, getTestDb } from "../../utils/test-plugin-ctx.js";

type TestCtx = Awaited<ReturnType<typeof createTestPluginCtx>>;

const contexts: TestCtx[] = [];

async function newCtx(): Promise<TestCtx> {
	const ctx = await createTestPluginCtx();
	contexts.push(ctx);
	return ctx;
}

async function publishLesson(
	ctx: TestCtx["ctx"],
	courseId: string,
	opts: { order?: number; title?: string } = {},
): Promise<string> {
	const lesson = await seedLesson(ctx, {
		courseId,
		order: opts.order ?? 0,
		title: opts.title,
	});
	await handleContentPublish(getTestDb(ctx), "lessons", lesson.id);
	return lesson.id;
}

async function publishCourse(ctx: TestCtx["ctx"], courseId: string): Promise<void> {
	await handleContentPublish(getTestDb(ctx), "courses", courseId);
}

afterEach(async () => {
	const pending = contexts.splice(0, contexts.length);
	await Promise.all(pending.map((ctx) => ctx.teardown()));
	eventBus.__resetHandlersForTests();
});

describe("engine/progress.tick", () => {
	it("creates a progress row for an enrolled user", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p1@test.local" });
		const course = await seedCourse(ctx, { title: "P1" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, course.id);
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const result = await progress.tick(ctx, student.id, {
			lessonId,
			positionSeconds: 30,
			percentComplete: 25,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.percentComplete).toBe(25);
		expect(result.data.positionSeconds).toBe(30);
		expect(result.data.completedAt).toBeUndefined();
	});

	it("monotonic on percentComplete — stale tick never regresses", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p2@test.local" });
		const course = await seedCourse(ctx, { title: "P2" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, course.id);
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		await progress.tick(ctx, student.id, {
			lessonId,
			positionSeconds: 60,
			percentComplete: 50,
		});
		const stale = await progress.tick(ctx, student.id, {
			lessonId,
			positionSeconds: 20,
			percentComplete: 10,
		});

		expect(stale.ok).toBe(true);
		if (!stale.ok) return;
		expect(stale.data.percentComplete).toBe(50);
		// positionSeconds does still track the latest (resume cursor).
		expect(stale.data.positionSeconds).toBe(20);
	});

	it("auto-completes when percentComplete >= 90 and emits lesson:completed", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p3@test.local" });
		const course = await seedCourse(ctx, { title: "P3" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, course.id);
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const received: LessonCompleted["data"][] = [];
		eventBus.on<LessonCompleted>("lesson:completed", "test-handler", async (event) => {
			received.push(event.data);
		});

		const result = await progress.tick(ctx, student.id, {
			lessonId,
			positionSeconds: 300,
			percentComplete: 95,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.completedAt).toBeDefined();
		expect(result.data.percentComplete).toBe(100);
		expect(received).toHaveLength(1);
	});

	it("returns LEARN_NOT_ENROLLED when the user is not enrolled", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p4@test.local" });
		const course = await seedCourse(ctx, { title: "P4" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, course.id);

		const result = await progress.tick(ctx, student.id, {
			lessonId,
			positionSeconds: 10,
			percentComplete: 5,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("LEARN_NOT_ENROLLED");
	});

	it("returns LEARN_LESSON_LOCKED for a missing lesson", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p5@test.local" });
		const result = await progress.tick(ctx, student.id, {
			lessonId: "does-not-exist",
			positionSeconds: 0,
			percentComplete: 0,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("LEARN_LESSON_LOCKED");
	});
});

describe("engine/progress.markLessonComplete + course completion", () => {
	it("emits course:completed when the final lesson finishes and stamps completedAt on the enrollment", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p6@test.local" });
		const course = await seedCourse(ctx, { title: "P6" });
		await publishCourse(ctx, course.id);
		const lesson1 = await publishLesson(ctx, course.id, { order: 0, title: "L1" });
		const lesson2 = await publishLesson(ctx, course.id, { order: 1, title: "L2" });
		const enrollment = await seedEnrollment(ctx, {
			userId: student.id,
			courseId: course.id,
		});

		const lessonEvents: LessonCompleted["data"][] = [];
		const courseEvents: CourseCompleted["data"][] = [];
		eventBus.on<LessonCompleted>("lesson:completed", "t-l", async (e) =>
			void lessonEvents.push(e.data),
		);
		eventBus.on<CourseCompleted>("course:completed", "t-c", async (e) =>
			void courseEvents.push(e.data),
		);

		const first = await progress.markLessonComplete(ctx, student.id, lesson1);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.data.courseComplete).toBe(false);
		expect(courseEvents).toHaveLength(0);

		const second = await progress.markLessonComplete(ctx, student.id, lesson2);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.data.courseComplete).toBe(true);
		expect(lessonEvents).toHaveLength(2);
		expect(courseEvents).toHaveLength(1);

		const enrollments = ctx.storage.enrollments;
		if (!enrollments) throw new Error("enrollments collection missing");
		const row = await enrollments.get(enrollment.id);
		expect(row).toBeDefined();
		if (!row) return;
		// Narrow to the shape seedEnrollment + engine writes.
		expect((row as { completedAt?: string }).completedAt).toBeDefined();
	});

	it("is idempotent across duplicate ticks past the threshold", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p7@test.local" });
		const course = await seedCourse(ctx, { title: "P7" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, course.id);
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const received: LessonCompleted["data"][] = [];
		eventBus.on<LessonCompleted>("lesson:completed", "test-handler", async (event) => {
			received.push(event.data);
		});

		await progress.tick(ctx, student.id, {
			lessonId,
			positionSeconds: 100,
			percentComplete: 95,
		});
		await progress.tick(ctx, student.id, {
			lessonId,
			positionSeconds: 110,
			percentComplete: 98,
		});

		expect(received).toHaveLength(1);
	});
});

describe("engine/progress.evaluateCourseComplete", () => {
	it("false when the course has zero published lessons", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p8@test.local" });
		const course = await seedCourse(ctx, { title: "Empty" });
		await publishCourse(ctx, course.id);

		const result = await progress.evaluateCourseComplete(ctx, student.id, course.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toBe(false);
	});

	it("true when every published lesson has a completed progress row", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p9@test.local" });
		const course = await seedCourse(ctx, { title: "Full" });
		await publishCourse(ctx, course.id);
		const lesson1 = await publishLesson(ctx, course.id, { order: 0 });
		const lesson2 = await publishLesson(ctx, course.id, { order: 1 });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		await progress.markLessonComplete(ctx, student.id, lesson1);
		const beforeLast = await progress.evaluateCourseComplete(ctx, student.id, course.id);
		expect(beforeLast.ok && beforeLast.data).toBe(false);

		await progress.markLessonComplete(ctx, student.id, lesson2);
		const afterLast = await progress.evaluateCourseComplete(ctx, student.id, course.id);
		expect(afterLast.ok && afterLast.data).toBe(true);
	});
});

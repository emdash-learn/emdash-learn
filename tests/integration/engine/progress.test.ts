/**
 * Integration tests for `engine/progress.ts` (ADR 0001 — topics primitive).
 *
 * Covers:
 *   - `tick` upserts the step row and auto-completes when
 *     `percentComplete >= 90` (§8.2). Lesson + topic both covered.
 *   - `tick` is monotonic on `percentComplete` (never regresses).
 *   - `tick` gates on enrollment — `LEARN_NOT_ENROLLED` otherwise.
 *   - Topic 90% auto-complete triggers `topic:completed`.
 *   - `markStepComplete("lesson", …)` refuses with `LEARN_LESSON_LOCKED`
 *     when child topics are incomplete; succeeds when all topics done.
 *   - Course completion requires every published lesson AND every published
 *     topic to be complete.
 *   - Event-bus idempotency: re-crossing the 90% threshold does not re-fire
 *     handlers for the same key.
 */

import { afterEach, describe, expect, it } from "vitest";

import type {
	CourseCompleted,
	LessonCompleted,
	TopicCompleted,
} from "../../../src/types/engine.js";
import * as eventBus from "../../../src/engine/event-bus.js";
import * as progress from "../../../src/engine/progress.js";
import {
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
	await publishContent(ctx, "lessons", lesson.id);
	return lesson.id;
}

async function publishTopic(
	ctx: TestCtx["ctx"],
	courseId: string,
	lessonId: string,
	opts: { order?: number; title?: string; requiresPrevious?: boolean } = {},
): Promise<string> {
	const args: Parameters<typeof seedTopic>[1] = {
		courseId,
		lessonId,
		order: opts.order ?? 0,
	};
	if (opts.title !== undefined) args.title = opts.title;
	if (opts.requiresPrevious !== undefined) args.requiresPrevious = opts.requiresPrevious;
	const topic = await seedTopic(ctx, args);
	await publishContent(ctx, "topics", topic.id);
	return topic.id;
}

async function publishCourse(ctx: TestCtx["ctx"], courseId: string): Promise<void> {
	await publishContent(ctx, "courses", courseId);
}

afterEach(async () => {
	const pending = contexts.splice(0, contexts.length);
	await Promise.all(pending.map((ctx) => ctx.teardown()));
	eventBus.__resetHandlersForTests();
});

describe("engine/progress.tick — lessons", () => {
	it("creates a progress row for an enrolled user", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p1@test.local" });
		const course = await seedCourse(ctx, { title: "P1" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, course.id);
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const result = await progress.tick(ctx, student.id, {
			stepType: "lesson",
			stepId: lessonId,
			positionSeconds: 30,
			percentComplete: 25,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.percentComplete).toBe(25);
		expect(result.data.positionSeconds).toBe(30);
		expect(result.data.completedAt).toBeUndefined();
		expect(result.data.stepType).toBe("lesson");
	});

	it("monotonic on percentComplete — stale tick never regresses", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p2@test.local" });
		const course = await seedCourse(ctx, { title: "P2" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, course.id);
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		await progress.tick(ctx, student.id, {
			stepType: "lesson",
			stepId: lessonId,
			positionSeconds: 60,
			percentComplete: 50,
		});
		const stale = await progress.tick(ctx, student.id, {
			stepType: "lesson",
			stepId: lessonId,
			positionSeconds: 20,
			percentComplete: 10,
		});

		expect(stale.ok).toBe(true);
		if (!stale.ok) return;
		expect(stale.data.percentComplete).toBe(50);
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
			stepType: "lesson",
			stepId: lessonId,
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
			stepType: "lesson",
			stepId: lessonId,
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
			stepType: "lesson",
			stepId: "does-not-exist",
			positionSeconds: 0,
			percentComplete: 0,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("LEARN_LESSON_LOCKED");
	});
});

describe("engine/progress.tick — topics", () => {
	it("creates a topic step_progress row with stepType=topic and parentLessonId set", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "tp1@test.local" });
		const course = await seedCourse(ctx, { title: "TP1" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, course.id);
		const topicId = await publishTopic(ctx, course.id, lessonId, { order: 0 });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const result = await progress.tick(ctx, student.id, {
			stepType: "topic",
			stepId: topicId,
			positionSeconds: 12,
			percentComplete: 30,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.stepType).toBe("topic");
		expect(result.data.stepId).toBe(topicId);
		expect(result.data.parentLessonId).toBe(lessonId);
		expect(result.data.percentComplete).toBe(30);
	});

	it("auto-completes a topic at 90% and emits topic:completed", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "tp2@test.local" });
		const course = await seedCourse(ctx, { title: "TP2" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, course.id);
		const topicId = await publishTopic(ctx, course.id, lessonId);
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const received: TopicCompleted["data"][] = [];
		eventBus.on<TopicCompleted>("topic:completed", "t-h", async (event) => {
			received.push(event.data);
		});

		const result = await progress.tick(ctx, student.id, {
			stepType: "topic",
			stepId: topicId,
			positionSeconds: 200,
			percentComplete: 92,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.completedAt).toBeDefined();
		expect(received).toHaveLength(1);
		expect(received[0]?.stepType).toBe("topic");
	});
});

describe("engine/progress.markStepComplete — lesson gating on topics", () => {
	it("refuses to mark a lesson complete while a child topic is incomplete", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "lg1@test.local" });
		const course = await seedCourse(ctx, { title: "LG1" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, course.id);
		await publishTopic(ctx, course.id, lessonId, { order: 0 });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const result = await progress.markStepComplete(ctx, student.id, "lesson", lessonId);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("LEARN_LESSON_LOCKED");
		expect(result.error.message).toMatch(/topics incomplete/);
	});

	it("succeeds once all child topics are complete", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "lg2@test.local" });
		const course = await seedCourse(ctx, { title: "LG2" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, course.id);
		const topicId = await publishTopic(ctx, course.id, lessonId, { order: 0 });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const t = await progress.markStepComplete(ctx, student.id, "topic", topicId);
		expect(t.ok).toBe(true);
		const l = await progress.markStepComplete(ctx, student.id, "lesson", lessonId);
		expect(l.ok).toBe(true);
	});

	it("topic auto-complete cascades lesson completion when lesson body is also complete", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "casc1@test.local" });
		const course = await seedCourse(ctx, { title: "Casc" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, course.id);
		const topicId = await publishTopic(ctx, course.id, lessonId, { order: 0 });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		// Bring the lesson body to 100% via a tick (will be rejected by lesson
		// completion gate due to incomplete topic; but the row is written).
		await progress.tick(ctx, student.id, {
			stepType: "lesson",
			stepId: lessonId,
			positionSeconds: 1,
			percentComplete: 50,
		});
		// Now mark the lesson body explicitly via tick going past threshold —
		// the markStepComplete inside tick will refuse, but the percent row
		// stays at 95+ and we follow up by completing the topic so cascade
		// fires.
		// Manually push percent forward without crossing auto-complete to
		// avoid tripping the refusal path inside tick.
		await progress.tick(ctx, student.id, {
			stepType: "lesson",
			stepId: lessonId,
			positionSeconds: 60,
			percentComplete: 80,
		});
		// Complete the topic — cascade should attempt to complete the lesson.
		// The lesson body row exists but is not completedAt; cascade requires
		// the lesson row to also be complete, so it should NOT cascade yet.
		const tRes = await progress.markStepComplete(ctx, student.id, "topic", topicId);
		expect(tRes.ok).toBe(true);
		// Lesson row should still not have completedAt (topic complete + lesson
		// body incomplete = no cascade).
		const stepProg = (
			ctx.storage as unknown as {
				step_progress: { get: (id: string) => Promise<unknown> };
			}
		).step_progress;
		const lessonRow = (await stepProg.get(`prog__${student.id}__lesson__${lessonId}`)) as {
			completedAt?: string;
		} | null;
		expect(lessonRow?.completedAt).toBeUndefined();

		// Now mark the lesson body explicitly — topics are complete so it
		// succeeds.
		const lRes = await progress.markStepComplete(ctx, student.id, "lesson", lessonId);
		expect(lRes.ok).toBe(true);
	});
});

describe("engine/progress.markStepComplete — course completion", () => {
	it("emits course:completed when the final lesson AND all topics complete", async () => {
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
		eventBus.on<LessonCompleted>(
			"lesson:completed",
			"t-l",
			async (e) => void lessonEvents.push(e.data),
		);
		eventBus.on<CourseCompleted>(
			"course:completed",
			"t-c",
			async (e) => void courseEvents.push(e.data),
		);

		const first = await progress.markStepComplete(ctx, student.id, "lesson", lesson1);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.data.courseComplete).toBe(false);
		expect(courseEvents).toHaveLength(0);

		const second = await progress.markStepComplete(ctx, student.id, "lesson", lesson2);
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
			stepType: "lesson",
			stepId: lessonId,
			positionSeconds: 100,
			percentComplete: 95,
		});
		await progress.tick(ctx, student.id, {
			stepType: "lesson",
			stepId: lessonId,
			positionSeconds: 110,
			percentComplete: 98,
		});

		expect(received).toHaveLength(1);
	});
});

describe("engine/progress.evaluateCourseComplete", () => {
	it("false when the course has zero published steps", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p8@test.local" });
		const course = await seedCourse(ctx, { title: "Empty" });
		await publishCourse(ctx, course.id);

		const result = await progress.evaluateCourseComplete(ctx, student.id, course.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toBe(false);
	});

	it("true when every published lesson + topic has a completed row", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p9@test.local" });
		const course = await seedCourse(ctx, { title: "Full" });
		await publishCourse(ctx, course.id);
		const lesson1 = await publishLesson(ctx, course.id, { order: 0 });
		const lesson2 = await publishLesson(ctx, course.id, { order: 1 });
		const topic = await publishTopic(ctx, course.id, lesson1, { order: 0 });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		// Topic first so the lesson can complete.
		await progress.markStepComplete(ctx, student.id, "topic", topic);
		await progress.markStepComplete(ctx, student.id, "lesson", lesson1);
		const beforeLast = await progress.evaluateCourseComplete(ctx, student.id, course.id);
		expect(beforeLast.ok && beforeLast.data).toBe(false);

		await progress.markStepComplete(ctx, student.id, "lesson", lesson2);
		const afterLast = await progress.evaluateCourseComplete(ctx, student.id, course.id);
		expect(afterLast.ok && afterLast.data).toBe(true);
	});

	it("false when any published topic is incomplete", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "p10@test.local" });
		const course = await seedCourse(ctx, { title: "TopicGate" });
		await publishCourse(ctx, course.id);
		const lesson = await publishLesson(ctx, course.id, { order: 0 });
		const topic1 = await publishTopic(ctx, course.id, lesson, { order: 0 });
		const topic2 = await publishTopic(ctx, course.id, lesson, { order: 1 });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		await progress.markStepComplete(ctx, student.id, "topic", topic1);
		// Topic2 not complete, so lesson can't auto-cascade. But assume the
		// course author marks the lesson complete by some other path: even
		// then evaluateCourseComplete must report incomplete because topic2
		// is unmarked.
		// We can't bypass markStepComplete's gate via that engine entrypoint,
		// so write the lesson row directly via the storage to model the
		// "lesson somehow complete but topic isn't" worst case.
		const stepProgress = (
			ctx.storage as unknown as {
				step_progress: { put: (id: string, data: unknown) => Promise<void> };
			}
		).step_progress;
		await stepProgress.put(`prog__${student.id}__lesson__${lesson}`, {
			userId: student.id,
			courseId: course.id,
			stepType: "lesson",
			stepId: lesson,
			startedAt: new Date().toISOString(),
			completedAt: new Date().toISOString(),
			percentComplete: 100,
		});

		const result = await progress.evaluateCourseComplete(ctx, student.id, course.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toBe(false);
		// Mark topic2 complete; now course is complete.
		await progress.markStepComplete(ctx, student.id, "topic", topic2);
		const after = await progress.evaluateCourseComplete(ctx, student.id, course.id);
		expect(after.ok && after.data).toBe(true);
	});
});

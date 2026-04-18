/**
 * Integration tests for `engine/curriculum.ts` (T07).
 *
 * Covers drip/gating against real plugin storage + content:
 *   - forUser returns lessons in `order` with drip + requires_previous gating.
 *   - Preview lessons visible without enrollment.
 *   - getLesson respects the gating (not-enrolled → LEARN_NOT_ENROLLED,
 *     locked-drip → LEARN_LESSON_LOCKED).
 *   - myLearning summarises percentComplete per enrollment.
 */

import { afterEach, describe, expect, it } from "vitest";
import { handleContentPublish } from "emdash";

import * as curriculum from "../../../src/engine/curriculum.js";
import * as progress from "../../../src/engine/progress.js";
import { settingKey } from "../../../src/kv-keys.js";
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
	args: Parameters<typeof seedLesson>[1],
): Promise<string> {
	const lesson = await seedLesson(ctx, args);
	await handleContentPublish(getTestDb(ctx), "lessons", lesson.id);
	return lesson.id;
}

async function publishCourse(ctx: TestCtx["ctx"], courseId: string): Promise<void> {
	await handleContentPublish(getTestDb(ctx), "courses", courseId);
}

afterEach(async () => {
	const pending = contexts.splice(0, contexts.length);
	await Promise.all(pending.map((ctx) => ctx.teardown()));
});

describe("engine/curriculum.forUser", () => {
	it("returns published lessons in order when the user is enrolled", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "c1@test.local" });
		const course = await seedCourse(ctx, { title: "C1" });
		await publishCourse(ctx, course.id);
		const l1 = await publishLesson(ctx, { courseId: course.id, order: 0, title: "L1" });
		const l2 = await publishLesson(ctx, { courseId: course.id, order: 1, title: "L2" });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const result = await curriculum.forUser(ctx, student.id, course.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.map((l) => l.id)).toEqual([l1, l2]);
		expect(result.data.every((l) => l.unlocked)).toBe(true);
	});

	it("hides non-preview lessons when the user is not enrolled, shows preview lessons", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "c2@test.local" });
		const course = await seedCourse(ctx, { title: "C2" });
		await publishCourse(ctx, course.id);
		await publishLesson(ctx, { courseId: course.id, order: 0, title: "hidden" });
		const preview = await publishLesson(ctx, {
			courseId: course.id,
			order: 1,
			title: "preview",
			isPreview: true,
		});

		const result = await curriculum.forUser(ctx, student.id, course.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toHaveLength(1);
		expect(result.data[0]?.id).toBe(preview);
	});

	it("locks a lesson with requires_previous until the previous lesson is completed", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "c3@test.local" });
		const course = await seedCourse(ctx, { title: "C3" });
		await publishCourse(ctx, course.id);
		const l1 = await publishLesson(ctx, { courseId: course.id, order: 0 });
		await publishLesson(ctx, {
			courseId: course.id,
			order: 1,
			requiresPrevious: true,
		});
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const before = await curriculum.forUser(ctx, student.id, course.id);
		expect(before.ok).toBe(true);
		if (!before.ok) return;
		expect(before.data[0]?.unlocked).toBe(true);
		expect(before.data[1]?.unlocked).toBe(false);

		await progress.markLessonComplete(ctx, student.id, l1);
		const after = await curriculum.forUser(ctx, student.id, course.id);
		expect(after.ok).toBe(true);
		if (!after.ok) return;
		expect(after.data[1]?.unlocked).toBe(true);
	});

	it("respects relative drip mode — lesson with drip_offset_days is locked before the offset elapses", async () => {
		const { ctx } = await newCtx();
		await ctx.kv.set(settingKey("dripMode"), "relative");
		const student = await seedStudent(ctx, { email: "c4@test.local" });
		const course = await seedCourse(ctx, { title: "C4" });
		await publishCourse(ctx, course.id);
		await publishLesson(ctx, { courseId: course.id, order: 0, dripOffsetDays: 7 });
		// Enroll back-dated so drip has not elapsed.
		const enrolledAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
		await seedEnrollment(ctx, {
			userId: student.id,
			courseId: course.id,
			enrolledAt,
		});

		const result = await curriculum.forUser(ctx, student.id, course.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data[0]?.unlocked).toBe(false);
	});
});

describe("engine/curriculum.getLesson", () => {
	it("returns the lesson body when unlocked and enrolled", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "l1@test.local" });
		const course = await seedCourse(ctx, { title: "L1C" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, { courseId: course.id, order: 0 });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const result = await curriculum.getLesson(ctx, student.id, lessonId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.id).toBe(lessonId);
	});

	it("rejects non-preview lessons for an unenrolled user with LEARN_NOT_ENROLLED", async () => {
		const { ctx } = await newCtx();
		const course = await seedCourse(ctx, { title: "LX" });
		await publishCourse(ctx, course.id);
		const lessonId = await publishLesson(ctx, { courseId: course.id, order: 0 });
		const student = await seedStudent(ctx, { email: "nope@test.local" });

		const result = await curriculum.getLesson(ctx, student.id, lessonId);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("LEARN_NOT_ENROLLED");
	});
});

describe("engine/curriculum.myLearning", () => {
	it("summarises percentComplete across enrollments", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "ml@test.local" });
		const course = await seedCourse(ctx, { title: "ML" });
		await publishCourse(ctx, course.id);
		const l1 = await publishLesson(ctx, { courseId: course.id, order: 0 });
		await publishLesson(ctx, { courseId: course.id, order: 1 });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		await progress.markLessonComplete(ctx, student.id, l1);
		const result = await curriculum.myLearning(ctx, student.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const entry = result.data.items.find((i) => i.courseId === course.id);
		expect(entry?.percentComplete).toBe(50);
		expect(entry?.nextLesson).toBeDefined();
	});
});

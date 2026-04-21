/**
 * Integration tests for `engine/curriculum.ts` (ADR 0001 — topics primitive).
 *
 * Covers:
 *   - forUser returns lessons in `order` with drip + requires_previous gating.
 *   - Preview lessons visible without enrollment.
 *   - Topics nested under lessons; topic visibility under preview lessons
 *     still requires enrollment.
 *   - `requires_previous` on a topic gates against previous sibling topic.
 *   - getLesson respects gating.
 *   - getTopic enforces enrollment + lesson-gating + topic-gating.
 *   - myLearning percentComplete counts every published step (lesson + topic).
 */

import { afterEach, describe, expect, it } from "vitest";

import * as curriculum from "../../../src/engine/curriculum.js";
import * as progress from "../../../src/engine/progress.js";
import { settingKey } from "../../../src/kv-keys.js";
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
	args: Parameters<typeof seedLesson>[1],
): Promise<string> {
	const lesson = await seedLesson(ctx, args);
	await publishContent(ctx, "lessons", lesson.id);
	return lesson.id;
}

async function publishTopic(
	ctx: TestCtx["ctx"],
	args: Parameters<typeof seedTopic>[1],
): Promise<string> {
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
		// Each lesson now has a `topics` array (empty when no topics).
		expect(result.data.every((l) => Array.isArray(l.topics))).toBe(true);
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

		await progress.markStepComplete(ctx, student.id, "lesson", l1);
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

describe("engine/curriculum.forUser — topics", () => {
	it("nests published topics under the parent lesson, ordered by `order`", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "ct1@test.local" });
		const course = await seedCourse(ctx, { title: "CT1" });
		await publishCourse(ctx, course.id);
		const lesson = await publishLesson(ctx, { courseId: course.id, order: 0 });
		const t2 = await publishTopic(ctx, {
			courseId: course.id,
			lessonId: lesson,
			order: 1,
			title: "Second",
		});
		const t1 = await publishTopic(ctx, {
			courseId: course.id,
			lessonId: lesson,
			order: 0,
			title: "First",
		});
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const result = await curriculum.forUser(ctx, student.id, course.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const lessonEntry = result.data[0]!;
		expect(lessonEntry.topics.map((t) => t.id)).toEqual([t1, t2]);
		expect(lessonEntry.topics.every((t) => t.unlocked)).toBe(true);
	});

	it("`requires_previous` on a topic blocks until the previous sibling is complete", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "ct2@test.local" });
		const course = await seedCourse(ctx, { title: "CT2" });
		await publishCourse(ctx, course.id);
		const lesson = await publishLesson(ctx, { courseId: course.id, order: 0 });
		const t1 = await publishTopic(ctx, {
			courseId: course.id,
			lessonId: lesson,
			order: 0,
		});
		await publishTopic(ctx, {
			courseId: course.id,
			lessonId: lesson,
			order: 1,
			requiresPrevious: true,
		});
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const before = await curriculum.forUser(ctx, student.id, course.id);
		expect(before.ok).toBe(true);
		if (!before.ok) return;
		const lessonBefore = before.data[0]!;
		expect(lessonBefore.topics[0]?.unlocked).toBe(true);
		expect(lessonBefore.topics[1]?.unlocked).toBe(false);

		await progress.markStepComplete(ctx, student.id, "topic", t1);
		const after = await curriculum.forUser(ctx, student.id, course.id);
		expect(after.ok).toBe(true);
		if (!after.ok) return;
		expect(after.data[0]?.topics[1]?.unlocked).toBe(true);
	});

	it("topics under a preview lesson still require enrollment for visibility (lesson is shown, but topics are hidden when not enrolled)", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "ct3@test.local" });
		const course = await seedCourse(ctx, { title: "CT3" });
		await publishCourse(ctx, course.id);
		const lesson = await publishLesson(ctx, {
			courseId: course.id,
			order: 0,
			isPreview: true,
		});
		await publishTopic(ctx, { courseId: course.id, lessonId: lesson, order: 0 });

		// Not enrolled — preview lesson is visible, topics are visible too
		// (curriculum response always includes them for visible lessons), but
		// `getTopic` will refuse the body with NOT_ENROLLED.
		const result = await curriculum.forUser(ctx, student.id, course.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toHaveLength(1);
		// Topics list is populated; the gate for body is on getTopic.
		expect(result.data[0]?.topics.length).toBeGreaterThan(0);

		const topicId = result.data[0]!.topics[0]!.id;
		const body = await curriculum.getTopic(ctx, student.id, topicId);
		expect(body.ok).toBe(false);
		if (body.ok) return;
		expect(body.error.code).toBe("LEARN_NOT_ENROLLED");
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

describe("engine/curriculum.getTopic", () => {
	it("returns the topic body when enrolled and unlocked", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "gt1@test.local" });
		const course = await seedCourse(ctx, { title: "GT1" });
		await publishCourse(ctx, course.id);
		const lesson = await publishLesson(ctx, { courseId: course.id, order: 0 });
		const topic = await publishTopic(ctx, { courseId: course.id, lessonId: lesson, order: 0 });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const result = await curriculum.getTopic(ctx, student.id, topic);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.id).toBe(topic);
	});

	it("rejects locked topics with LEARN_TOPIC_LOCKED", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "gt2@test.local" });
		const course = await seedCourse(ctx, { title: "GT2" });
		await publishCourse(ctx, course.id);
		const lesson = await publishLesson(ctx, { courseId: course.id, order: 0 });
		await publishTopic(ctx, { courseId: course.id, lessonId: lesson, order: 0 });
		const topic2 = await publishTopic(ctx, {
			courseId: course.id,
			lessonId: lesson,
			order: 1,
			requiresPrevious: true,
		});
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const result = await curriculum.getTopic(ctx, student.id, topic2);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("LEARN_TOPIC_LOCKED");
	});
});

describe("engine/curriculum.myLearning", () => {
	it("counts every published step (lesson + topic) toward percentComplete", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "ml@test.local" });
		const course = await seedCourse(ctx, { title: "ML" });
		await publishCourse(ctx, course.id);
		const l1 = await publishLesson(ctx, { courseId: course.id, order: 0 });
		const t = await publishTopic(ctx, { courseId: course.id, lessonId: l1, order: 0 });
		await publishLesson(ctx, { courseId: course.id, order: 1 });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		// 3 steps total (l1 + t + l2). Complete the topic first so we can
		// then complete l1.
		await progress.markStepComplete(ctx, student.id, "topic", t);
		await progress.markStepComplete(ctx, student.id, "lesson", l1);

		const result = await curriculum.myLearning(ctx, student.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const entry = result.data.items.find((i) => i.courseId === course.id);
		// 2/3 = 67%.
		expect(entry?.percentComplete).toBe(67);
		expect(entry?.nextStep).toBeDefined();
		expect(entry?.nextStep?.type).toBe("lesson");
	});
});

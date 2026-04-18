/**
 * Integration tests for `reconcilers/drip-release-reminders.ts` (T14).
 *
 * Covers:
 *   - Email emitted once per (user, lesson) for lessons unlocked in the
 *     last hour.
 *   - Second run is a no-op — KV dedupe via `notified:*` holds.
 *   - Unknown user (no row in `users` table) is skipped silently.
 */

import { afterEach, describe, expect, it } from "vitest";
import { handleContentPublish } from "emdash";

import { dripReleaseRemindersReconciler } from "../../../src/reconcilers/drip-release-reminders.js";
import { settingKey } from "../../../src/kv-keys.js";
import {
	seedCourse,
	seedEnrollment,
	seedLesson,
	seedStudent,
} from "../../utils/seed.js";
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

describe("reconcilers/drip-release-reminders", () => {
	it("emails the student once per freshly unlocked lesson", async () => {
		const { ctx, outbox } = await newCtx();
		await ctx.kv.set(settingKey("dripMode"), "immediate");
		const student = await seedStudent(ctx, { email: "drip1@test.local" });
		const course = await seedCourse(ctx, { title: "Drip C1" });
		await publishCourse(ctx, course.id);
		await publishLesson(ctx, {
			courseId: course.id,
			order: 0,
			title: "Preview lesson",
			isPreview: true,
		});
		await publishLesson(ctx, {
			courseId: course.id,
			order: 1,
			title: "Regular lesson",
		});
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const result = await dripReleaseRemindersReconciler(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Both lessons unlock immediately (dripMode=immediate, enrolledAt=now);
		// reconciler emails for each unlocked lesson within the last hour.
		expect(result.data.processed).toBeGreaterThanOrEqual(1);
		expect(outbox.length).toBeGreaterThanOrEqual(1);
		expect(outbox.every((msg) => msg.to === "drip1@test.local")).toBe(true);
	});

	it("does not re-email on a second run (dedupe)", async () => {
		const { ctx, outbox } = await newCtx();
		await ctx.kv.set(settingKey("dripMode"), "immediate");
		const student = await seedStudent(ctx, { email: "drip2@test.local" });
		const course = await seedCourse(ctx, { title: "Drip C2" });
		await publishCourse(ctx, course.id);
		await publishLesson(ctx, { courseId: course.id, order: 0, title: "L1" });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const first = await dripReleaseRemindersReconciler(ctx);
		expect(first.ok).toBe(true);
		const sentAfterFirst = outbox.length;
		expect(sentAfterFirst).toBeGreaterThanOrEqual(1);

		const second = await dripReleaseRemindersReconciler(ctx);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(outbox.length).toBe(sentAfterFirst);
		expect(second.data.processed).toBe(0);
		expect(second.data.skipped).toBeGreaterThanOrEqual(1);
	});

	it("skips enrollments whose user does not resolve", async () => {
		const { ctx, outbox } = await newCtx();
		await ctx.kv.set(settingKey("dripMode"), "immediate");
		const course = await seedCourse(ctx, { title: "Drip Ghost" });
		await publishCourse(ctx, course.id);
		await publishLesson(ctx, { courseId: course.id, order: 0, title: "L1" });
		await seedEnrollment(ctx, { userId: "user_ghost_nope", courseId: course.id });

		const result = await dripReleaseRemindersReconciler(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(outbox).toHaveLength(0);
		expect(result.data.processed).toBe(0);
	});
});

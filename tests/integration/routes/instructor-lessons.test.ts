/**
 * Integration tests for `lesson:list` (admin Curriculum tab support).
 *
 * Covers:
 *   - Returns published lessons for the requested course (with title/order).
 *   - Filters out lessons belonging to other courses.
 *   - Returns lessons that have zero topics (the very gap the route was
 *     introduced to close).
 *   - Respects the `limit` parameter (caps the returned page size).
 *   - SUBSCRIBER role → LEARN_FORBIDDEN (gate enforcement).
 */

import { afterEach, describe, expect, it } from "vitest";
import { handleContentPublish } from "emdash";

import { instructorLessonRoutes } from "../../../src/routes/instructor-lessons.js";
import { LEARN_ERRORS } from "../../../src/constants.js";
import { seedCourse, seedLesson, type SeedLessonInput } from "../../utils/seed.js";
import { createTestPluginCtx, getTestDb } from "../../utils/test-plugin-ctx.js";

type TestCtx = Awaited<ReturnType<typeof createTestPluginCtx>>;

const contexts: TestCtx[] = [];

async function newCtx(opts: Parameters<typeof createTestPluginCtx>[0] = {}): Promise<TestCtx> {
	const ctx = await createTestPluginCtx(opts);
	contexts.push(ctx);
	return ctx;
}

afterEach(async () => {
	const pending = contexts.splice(0, contexts.length);
	await Promise.all(pending.map((ctx) => ctx.teardown()));
});

function makeRouteCtx(fixture: TestCtx, input: unknown) {
	return { ...fixture.ctx, user: fixture.user, input };
}

interface LessonListResp {
	items: Array<{
		id: string;
		title?: string;
		order?: number;
		courseId?: string;
		status?: string;
	}>;
	cursor?: string;
	hasMore: boolean;
}

async function runLessonList(
	fixture: TestCtx,
	input: Record<string, unknown>,
): Promise<LessonListResp> {
	const route = instructorLessonRoutes["lesson:list"];
	// eslint-disable-next-line typescript-eslint/no-explicit-any
	const out = await route.handler(makeRouteCtx(fixture, input) as any);
	return out as LessonListResp;
}

async function publishLesson(
	fixture: TestCtx,
	args: SeedLessonInput,
): Promise<{ id: string; title: string; order: number }> {
	const lesson = await seedLesson(fixture.ctx, args);
	await handleContentPublish(getTestDb(fixture.ctx), "lessons", lesson.id);
	return {
		id: lesson.id,
		title: args.title ?? "Seed Lesson",
		order: args.order ?? 0,
	};
}

describe("routes/instructor-lessons :: lesson:list", () => {
	it("returns published lessons for a course (including those without topics)", async () => {
		const fixture = await newCtx();
		const course = await seedCourse(fixture.ctx, { title: "React" });
		const l1 = await publishLesson(fixture, {
			courseId: course.id,
			order: 0,
			title: "Introduction",
		});
		const l2 = await publishLesson(fixture, {
			courseId: course.id,
			order: 1,
			title: "JSX Basics",
		});

		const result = await runLessonList(fixture, { courseId: course.id });
		expect(result.hasMore).toBe(false);
		expect(result.items).toHaveLength(2);
		const byId = new Map(result.items.map((i) => [i.id, i]));
		expect(byId.get(l1.id)).toMatchObject({ title: "Introduction", order: 0, courseId: course.id });
		expect(byId.get(l2.id)).toMatchObject({ title: "JSX Basics", order: 1, courseId: course.id });
	});

	it("filters out lessons that belong to other courses", async () => {
		const fixture = await newCtx();
		const course = await seedCourse(fixture.ctx, { title: "Target" });
		const otherCourse = await seedCourse(fixture.ctx, { title: "Other" });
		const ours = await publishLesson(fixture, {
			courseId: course.id,
			order: 0,
			title: "Ours",
		});
		await publishLesson(fixture, {
			courseId: otherCourse.id,
			order: 0,
			title: "Theirs",
		});

		const result = await runLessonList(fixture, { courseId: course.id });
		expect(result.items.map((i) => i.id)).toEqual([ours.id]);
	});

	it("respects the `limit` parameter", async () => {
		const fixture = await newCtx();
		const course = await seedCourse(fixture.ctx, { title: "Limited" });
		for (let i = 0; i < 5; i += 1) {
			// eslint-disable-next-line no-await-in-loop
			await publishLesson(fixture, {
				courseId: course.id,
				order: i,
				title: `Lesson ${i}`,
			});
		}

		const capped = await runLessonList(fixture, { courseId: course.id, limit: 2 });
		expect(capped.items).toHaveLength(2);

		const all = await runLessonList(fixture, { courseId: course.id, limit: 50 });
		expect(all.items).toHaveLength(5);
		expect(all.hasMore).toBe(false);
	});

	it("ignores lessons without topics — they still appear", async () => {
		// Regression for the original bug: the previous Curriculum tab grouped
		// by lessonId from topic.list, so lessons with zero topics never
		// surfaced. lesson:list returns them regardless.
		const fixture = await newCtx();
		const course = await seedCourse(fixture.ctx, { title: "Sparse" });
		const lonely = await publishLesson(fixture, {
			courseId: course.id,
			order: 0,
			title: "Lonely Lesson",
		});

		const result = await runLessonList(fixture, { courseId: course.id });
		expect(result.items.map((i) => i.id)).toContain(lonely.id);
		expect(result.items[0]?.title).toBe("Lonely Lesson");
	});

	it("rejects SUBSCRIBER (role 10) with LEARN_FORBIDDEN", async () => {
		const fixture = await newCtx({
			user: { id: "u_sub", email: "sub@test.local", role: 10 },
		});
		const course = await seedCourse(fixture.ctx, { title: "Gated" });

		await expect(runLessonList(fixture, { courseId: course.id })).rejects.toMatchObject({
			name: "PluginRouteError",
			code: LEARN_ERRORS.FORBIDDEN,
		});
	});
});

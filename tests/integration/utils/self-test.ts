/**
 * Smoke test for the T04 test infrastructure.
 *
 * Proves that `createTestPluginCtx` boots a full emdash runtime, installs
 * the plugin, provisions the `courses` / `lessons` content collections, and
 * exposes the plugin-storage accessors declared in the descriptor. If this
 * file passes, every downstream integration test file gets a trustworthy
 * fixture.
 *
 * File name is `self-test.ts` (not `*.test.ts`) per §26 T04's deliverable
 * list. `vitest.config.ts` includes this path explicitly so it runs under
 * `pnpm test:integration` without polluting the default `**` glob.
 */

import { afterEach, describe, expect, it } from "vitest";

import { createTestPluginCtx, type TestPluginCtx } from "../../utils/test-plugin-ctx.js";
import { seedCourse, seedLesson, seedStudent } from "../../utils/seed.js";

describe("T04 self-test: createTestPluginCtx", () => {
	let fixture: TestPluginCtx | undefined;

	afterEach(async () => {
		await fixture?.teardown();
		fixture = undefined;
	});

	it("boots ctx with storage, kv, content, and test spies", async () => {
		fixture = await createTestPluginCtx();

		expect(fixture.ctx.plugin.id).toBe("lms-core");
		expect(fixture.ctx.kv).toBeDefined();
		expect(fixture.ctx.content).toBeDefined();
		expect(typeof fixture.ctx.email?.send).toBe("function");
		expect(typeof fixture.ctx.http?.fetch).toBe("function");

		// Storage collections declared on the descriptor materialize at
		// install time. The smoke test asserts the critical ones exist;
		// future tests pick up the rest.
		// eslint-disable-next-line typescript-eslint/no-explicit-any -- runtime storage shape (T03 types unused here)
		const storage = fixture.ctx.storage as any;
		expect(storage.enrollments).toBeDefined();
		expect(typeof storage.enrollments.put).toBe("function");
		expect(typeof storage.enrollments.query).toBe("function");
		expect(storage.step_progress).toBeDefined();
		expect(storage.quizzes).toBeDefined();
		expect(storage.certificates).toBeDefined();
	});

	it("seeds a student, course, and lesson end-to-end", async () => {
		fixture = await createTestPluginCtx();
		const { ctx } = fixture;

		const student = await seedStudent(ctx, {
			email: "alice@test.local",
			name: "Alice",
		});
		expect(student.id).toMatch(/^user_/);
		expect(student.email).toBe("alice@test.local");

		const course = await seedCourse(ctx, {
			title: "Intro to Testing",
			priceCents: 0,
			enrollmentOpen: true,
		});
		expect(course.id).toBeDefined();
		expect(course.type).toBe("courses");
		expect(course.data.title).toBe("Intro to Testing");

		const lesson = await seedLesson(ctx, {
			courseId: course.id,
			title: "Lesson 1",
			order: 1,
			isPreview: true,
		});
		expect(lesson.type).toBe("lessons");
		expect(lesson.data.course).toBe(course.id);
		expect(lesson.data.order).toBe(1);

		// Storage is writable + queryable round-trip.
		// eslint-disable-next-line typescript-eslint/no-explicit-any -- runtime storage shape
		const enrollments = (ctx.storage as any).enrollments as {
			put(id: string, data: unknown): Promise<void>;
			query(opts?: unknown): Promise<{ items: Array<{ id: string }> }>;
		};
		await enrollments.put("enr_self_1", {
			userId: student.id,
			courseId: course.id,
			enrolledAt: "2026-04-17T00:00:00.000Z",
			source: "free",
		});
		const rows = await enrollments.query({
			where: { userId: student.id },
		});
		expect(rows.items).toHaveLength(1);
		expect(rows.items[0]?.id).toBe("enr_self_1");
	});

	it("captures emails in the outbox and throws on unmapped fetch", async () => {
		fixture = await createTestPluginCtx();
		const { ctx, outbox } = fixture;

		await ctx.email!.send({
			to: "alice@test.local",
			subject: "Welcome",
			text: "Enrolled.",
		});
		expect(outbox).toHaveLength(1);
		expect(outbox[0]?.subject).toBe("Welcome");

		await expect(ctx.http!.fetch("https://unmapped.example/")).rejects.toThrow(/no fakeHttp entry/);
	});
});

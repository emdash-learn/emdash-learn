/**
 * Integration tests for `hooks/comment.ts` (T13 / §21 Phase 5).
 *
 * Covers the six matrix cases from the PRD:
 *   1. Gate off (default KV state)                 → allow.
 *   2. Gate on, non-lessons collection             → allow.
 *   3. Gate on, anonymous commenter (null userId)  → refuse.
 *   4. Gate on, active enrollment                  → allow.
 *   5. Gate on, no enrollment row                  → refuse.
 *   6. Gate on, enrollment revoked                 → refuse.
 *
 * The hook is exercised directly as a function — no HookPipeline wrapping —
 * because T13 deliberately defers registration (see scope note in the task).
 */

import { afterEach, describe, expect, it } from "vitest";
import type { CommentBeforeCreateEvent } from "emdash";

import { commentBeforeCreate } from "../../../src/hooks/comment.js";
import { settingKey } from "../../../src/kv-keys.js";
import { seedCourse, seedEnrollment, seedLesson } from "../../utils/seed.js";
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
	await Promise.all(pending.map((c) => c.teardown()));
});

/**
 * Build a minimally-valid CommentBeforeCreateEvent. Callers override only
 * the fields they care about per test; everything else gets sensible
 * defaults that land on the `lessons` collection so the gate engages.
 */
function evt(
	overrides: Partial<CommentBeforeCreateEvent["comment"]> = {},
): CommentBeforeCreateEvent {
	return {
		comment: {
			collection: "lessons",
			contentId: "lesson_x",
			parentId: null,
			authorName: "Alice",
			authorEmail: "alice@x.com",
			authorUserId: "u_1",
			body: "hi",
			ipHash: null,
			userAgent: null,
			...overrides,
		},
		metadata: {},
	};
}

describe("hooks/commentBeforeCreate", () => {
	it("gate off: allows even without enrollment", async () => {
		const { ctx } = await newCtx();
		// Default KV state leaves commentGateRequiresEnrollment = false.
		const result = await commentBeforeCreate(evt(), ctx);
		expect(result).toBeUndefined();
	});

	it("gate on, non-lessons collection: allows", async () => {
		const { ctx } = await newCtx();
		await ctx.kv.set(settingKey("commentGateRequiresEnrollment"), true);
		const result = await commentBeforeCreate(evt({ collection: "posts" }), ctx);
		expect(result).toBeUndefined();
	});

	it("gate on, anonymous commenter: refuses", async () => {
		const { ctx } = await newCtx();
		await ctx.kv.set(settingKey("commentGateRequiresEnrollment"), true);
		const result = await commentBeforeCreate(evt({ authorUserId: null }), ctx);
		expect(result).toBe(false);
	});

	it("gate on, enrolled user: allows", async () => {
		const { ctx } = await newCtx();
		await ctx.kv.set(settingKey("commentGateRequiresEnrollment"), true);
		const course = await seedCourse(ctx, { title: "Gated Course" });
		const lesson = await seedLesson(ctx, { courseId: course.id, title: "L1" });
		await seedEnrollment(ctx, { userId: "u_enrolled", courseId: course.id });

		const result = await commentBeforeCreate(
			evt({ contentId: lesson.id, authorUserId: "u_enrolled" }),
			ctx,
		);
		expect(result).toBeUndefined();
	});

	it("gate on, non-enrolled user: refuses", async () => {
		const { ctx } = await newCtx();
		await ctx.kv.set(settingKey("commentGateRequiresEnrollment"), true);
		const course = await seedCourse(ctx, { title: "Gated Course" });
		const lesson = await seedLesson(ctx, { courseId: course.id, title: "L1" });
		// No enrollment seeded.

		const result = await commentBeforeCreate(
			evt({ contentId: lesson.id, authorUserId: "u_outsider" }),
			ctx,
		);
		expect(result).toBe(false);
	});

	it("gate on, revoked enrollment: refuses", async () => {
		const { ctx } = await newCtx();
		await ctx.kv.set(settingKey("commentGateRequiresEnrollment"), true);
		const course = await seedCourse(ctx, { title: "Gated Course" });
		const lesson = await seedLesson(ctx, { courseId: course.id, title: "L1" });
		const enr = await seedEnrollment(ctx, { userId: "u_revoked", courseId: course.id });

		// seedEnrollment has no revokedAt input; patch the row directly through
		// ctx.storage so we exercise the "revoked" branch of the gate.
		const store = (
			ctx.storage as Record<string, { get: (id: string) => Promise<unknown>; put: (id: string, data: unknown) => Promise<void> } | undefined>
		)["enrollments"];
		if (!store) throw new Error("enrollments storage unexpectedly missing");
		const existing = (await store.get(enr.id)) as Record<string, unknown> | null;
		if (!existing) throw new Error("seeded enrollment vanished");
		await store.put(enr.id, { ...existing, revokedAt: "2026-04-01T00:00:00.000Z" });

		const result = await commentBeforeCreate(
			evt({ contentId: lesson.id, authorUserId: "u_revoked" }),
			ctx,
		);
		expect(result).toBe(false);
	});
});

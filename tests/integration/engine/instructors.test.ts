/**
 * Integration tests for `engine/instructors.ts` (T11).
 *
 * Covers the full assignment lifecycle against real plugin storage:
 *   - `assign` creates on first call, updates role on repeat with different role,
 *     no-ops on repeat with same role.
 *   - `unassign` deletes; re-driving is a no-op success.
 *   - `listForCourse` / `listForUser` return exactly the matching rows.
 *   - `isInstructorOf` is a hot-path boolean (used by `authz.requireInstructor`).
 */

import { afterEach, describe, expect, it } from "vitest";

import * as instructors from "../../../src/engine/instructors.js";
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

describe("engine/instructors.assign", () => {
	it("creates a row on first call", async () => {
		const { ctx } = await newCtx();
		const result = await instructors.assign(ctx, "c1", "u1", "lead");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toEqual({ courseId: "c1", userId: "u1", role: "lead" });
	});

	it("is idempotent when the role matches", async () => {
		const { ctx } = await newCtx();
		await instructors.assign(ctx, "c1", "u1", "co");
		const again = await instructors.assign(ctx, "c1", "u1", "co");
		expect(again.ok).toBe(true);
		const list = await instructors.listForCourse(ctx, "c1");
		expect(list.ok && list.data.length).toBe(1);
	});

	it("updates the role when a different role is assigned", async () => {
		const { ctx } = await newCtx();
		await instructors.assign(ctx, "c1", "u1", "co");
		const promoted = await instructors.assign(ctx, "c1", "u1", "lead");
		expect(promoted.ok).toBe(true);
		if (!promoted.ok) return;
		expect(promoted.data.role).toBe("lead");
		const list = await instructors.listForCourse(ctx, "c1");
		expect(list.ok && list.data.length).toBe(1);
	});

	it("rejects empty courseId / userId with LEARN_FORBIDDEN", async () => {
		const { ctx } = await newCtx();
		const result = await instructors.assign(ctx, "", "u1", "lead");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("LEARN_FORBIDDEN");
	});
});

describe("engine/instructors.unassign", () => {
	it("deletes the row", async () => {
		const { ctx } = await newCtx();
		await instructors.assign(ctx, "c1", "u1", "lead");
		const removed = await instructors.unassign(ctx, "c1", "u1");
		expect(removed.ok).toBe(true);
		expect(await instructors.isInstructorOf(ctx, "u1", "c1")).toBe(false);
	});

	it("is a no-op success when the row does not exist", async () => {
		const { ctx } = await newCtx();
		const removed = await instructors.unassign(ctx, "c1", "u1");
		expect(removed.ok).toBe(true);
	});
});

describe("engine/instructors.listForCourse / listForUser", () => {
	it("listForCourse returns exactly the rows for the given course", async () => {
		const { ctx } = await newCtx();
		await instructors.assign(ctx, "c1", "u1", "lead");
		await instructors.assign(ctx, "c1", "u2", "co");
		await instructors.assign(ctx, "c2", "u1", "ta");

		const list = await instructors.listForCourse(ctx, "c1");
		expect(list.ok).toBe(true);
		if (!list.ok) return;
		const userIds = list.data.map((row) => row.userId).toSorted();
		expect(userIds).toEqual(["u1", "u2"]);
	});

	it("listForUser returns every course the user instructs", async () => {
		const { ctx } = await newCtx();
		await instructors.assign(ctx, "c1", "u1", "lead");
		await instructors.assign(ctx, "c2", "u1", "ta");
		await instructors.assign(ctx, "c3", "u2", "co");

		const list = await instructors.listForUser(ctx, "u1");
		expect(list.ok).toBe(true);
		if (!list.ok) return;
		const courseIds = list.data.map((row) => row.courseId).toSorted();
		expect(courseIds).toEqual(["c1", "c2"]);
	});
});

describe("engine/instructors.isInstructorOf", () => {
	it("returns true iff an assignment row exists", async () => {
		const { ctx } = await newCtx();
		expect(await instructors.isInstructorOf(ctx, "u1", "c1")).toBe(false);
		await instructors.assign(ctx, "c1", "u1", "co");
		expect(await instructors.isInstructorOf(ctx, "u1", "c1")).toBe(true);
		await instructors.unassign(ctx, "c1", "u1");
		expect(await instructors.isInstructorOf(ctx, "u1", "c1")).toBe(false);
	});

	it("returns false for empty inputs without throwing", async () => {
		const { ctx } = await newCtx();
		expect(await instructors.isInstructorOf(ctx, "", "c1")).toBe(false);
		expect(await instructors.isInstructorOf(ctx, "u1", "")).toBe(false);
	});
});

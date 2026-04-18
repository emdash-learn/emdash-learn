/**
 * Integration tests for `engine/cohorts.ts` (T10).
 *
 * Covers create/list/get, add/remove member with capacity semantics (D43),
 * and importFromEmails unknown-email handling (D50). Real plugin storage
 * exercises the uniqueness indexes declared on both collections.
 */

import { afterEach, describe, expect, it } from "vitest";

import * as cohorts from "../../../src/engine/cohorts.js";
import { seedStudent } from "../../utils/seed.js";
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

describe("engine/cohorts.create + list + get", () => {
	it("creates a cohort and returns the stored record", async () => {
		const { ctx } = await newCtx();
		const result = await cohorts.create(ctx, { slug: "spring-26", title: "Spring 26" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.id).toMatch(/^coh_/);
		expect(result.data.data.slug).toBe("spring-26");
	});

	it("rejects duplicate slug with LEARN_SCHEMA_CONFLICT", async () => {
		const { ctx } = await newCtx();
		await cohorts.create(ctx, { slug: "dup", title: "A" });
		const again = await cohorts.create(ctx, { slug: "dup", title: "B" });
		expect(again.ok).toBe(false);
		if (again.ok) return;
		expect(again.error.code).toBe("LEARN_SCHEMA_CONFLICT");
	});

	it("list returns every cohort", async () => {
		const { ctx } = await newCtx();
		await cohorts.create(ctx, { slug: "a", title: "A" });
		await cohorts.create(ctx, { slug: "b", title: "B" });
		const page = await cohorts.list(ctx);
		expect(page.ok).toBe(true);
		if (!page.ok) return;
		expect(page.data.items).toHaveLength(2);
	});

	it("get returns cohort + members", async () => {
		const { ctx } = await newCtx();
		const created = await cohorts.create(ctx, { slug: "g", title: "G" });
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		await cohorts.addMember(ctx, created.data.id, "u_1");
		const full = await cohorts.get(ctx, created.data.id);
		expect(full.ok).toBe(true);
		if (!full.ok) return;
		expect(full.data.members).toHaveLength(1);
	});
});

describe("engine/cohorts.addMember + removeMember", () => {
	it("adds a student by default; idempotent repeat-add returns the same row", async () => {
		const { ctx } = await newCtx();
		const created = await cohorts.create(ctx, { slug: "am", title: "Am" });
		if (!created.ok) throw new Error("setup failed");

		const first = await cohorts.addMember(ctx, created.data.id, "u_1");
		const second = await cohorts.addMember(ctx, created.data.id, "u_1");
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.data.id).toBe(second.data.id);
		expect(first.data.data.role).toBe("student");
	});

	it("enforces capacity with LEARN_COHORT_AT_CAPACITY (tolerates overage per D43)", async () => {
		const { ctx } = await newCtx();
		const created = await cohorts.create(ctx, { slug: "cap", title: "Cap", capacity: 1 });
		if (!created.ok) throw new Error("setup failed");
		await cohorts.addMember(ctx, created.data.id, "u_a");
		const overflow = await cohorts.addMember(ctx, created.data.id, "u_b");
		expect(overflow.ok).toBe(false);
		if (overflow.ok) return;
		expect(overflow.error.code).toBe("LEARN_COHORT_AT_CAPACITY");
	});

	it("removeMember deletes an existing row and is a no-op on missing", async () => {
		const { ctx } = await newCtx();
		const created = await cohorts.create(ctx, { slug: "rm", title: "Rm" });
		if (!created.ok) throw new Error("setup failed");
		await cohorts.addMember(ctx, created.data.id, "u_1");
		const removed = await cohorts.removeMember(ctx, created.data.id, "u_1");
		const again = await cohorts.removeMember(ctx, created.data.id, "u_1");
		expect(removed.ok && again.ok).toBe(true);
	});
});

describe("engine/cohorts.importFromEmails (D50)", () => {
	it("resolves known emails and reports unknowns without creating users", async () => {
		const { ctx } = await newCtx();
		const alice = await seedStudent(ctx, { email: "alice@x.com" });
		await seedStudent(ctx, { email: "bob@x.com" });
		const created = await cohorts.create(ctx, { slug: "imp", title: "Imp" });
		if (!created.ok) throw new Error("setup failed");

		const result = await cohorts.importFromEmails(ctx, created.data.id, [
			"alice@x.com",
			"bob@x.com",
			"ghost@x.com",
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.added).toHaveLength(2);
		expect(result.data.unknownEmails).toEqual(["ghost@x.com"]);
		// Alice landed in the cohort.
		const addedUsers = result.data.added.map((r) => r.data.userId).toSorted();
		expect(addedUsers).toContain(alice.id);
	});

	it("returns alreadyMembers for previously-added users", async () => {
		const { ctx } = await newCtx();
		await seedStudent(ctx, { email: "alice@x.com" });
		const created = await cohorts.create(ctx, { slug: "imp2", title: "Imp2" });
		if (!created.ok) throw new Error("setup failed");

		await cohorts.importFromEmails(ctx, created.data.id, ["alice@x.com"]);
		const second = await cohorts.importFromEmails(ctx, created.data.id, ["alice@x.com"]);

		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.data.added).toHaveLength(0);
		expect(second.data.alreadyMembers).toEqual(["alice@x.com"]);
	});
});

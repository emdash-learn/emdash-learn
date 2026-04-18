/**
 * Integration tests for `reconcilers/flush-email-queue.ts` (T14).
 *
 * Covers:
 *   - Drains queued emails into the outbox when provider is present.
 *   - Leaves queue intact + returns `skipped` count when provider is
 *     unavailable.
 */

import { afterEach, describe, expect, it } from "vitest";

import { flushEmailQueueReconciler } from "../../../src/reconcilers/flush-email-queue.js";
import { emailQueueKey } from "../../../src/kv-keys.js";
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

describe("reconcilers/flush-email-queue", () => {
	it("delivers queued emails to the outbox", async () => {
		const { ctx, outbox } = await newCtx();
		await ctx.kv.set(emailQueueKey("a"), {
			to: "a@test.local",
			subject: "A",
			text: "hello A",
		});
		await ctx.kv.set(emailQueueKey("b"), {
			to: "b@test.local",
			subject: "B",
			text: "hello B",
		});
		await ctx.kv.set(emailQueueKey("c"), {
			to: "c@test.local",
			subject: "C",
			text: "hello C",
		});

		const result = await flushEmailQueueReconciler(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.processed).toBe(3);
		expect(result.data.skipped).toBe(0);
		expect(result.data.errors).toBe(0);
		expect(outbox).toHaveLength(3);

		const remaining = await ctx.kv.list("queue:email:");
		expect(remaining).toHaveLength(0);
	});

	it("marks all entries as skipped when no provider is configured", async () => {
		const { ctx, outbox } = await newCtx();
		await ctx.kv.set(emailQueueKey("x"), {
			to: "x@test.local",
			subject: "X",
			text: "hello X",
		});
		await ctx.kv.set(emailQueueKey("y"), {
			to: "y@test.local",
			subject: "Y",
			text: "hello Y",
		});

		// Simulate "no email provider" — drop the capability on a cloned ctx
		// so the underlying `flush()` takes the remaining-only branch.
		const providerlessCtx = { ...ctx, email: undefined } as typeof ctx;

		const result = await flushEmailQueueReconciler(providerlessCtx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.processed).toBe(0);
		expect(result.data.skipped).toBe(2);
		expect(result.data.errors).toBe(0);
		expect(outbox).toHaveLength(0);

		const remaining = await ctx.kv.list("queue:email:");
		expect(remaining).toHaveLength(2);
	});
});

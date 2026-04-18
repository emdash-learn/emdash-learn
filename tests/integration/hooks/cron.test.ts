/**
 * Integration tests for `hooks/cron.ts` (T14).
 *
 * Each known event name routes to its reconciler; an unknown event is a
 * no-op that does not throw.
 */

import { afterEach, describe, expect, it } from "vitest";

import { cronDispatch } from "../../../src/hooks/cron.js";
import { emailQueueKey } from "../../../src/kv-keys.js";
import { seedCourse, seedEnrollment, seedStudent } from "../../utils/seed.js";
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

describe("hooks/cron dispatch", () => {
	it("routes 'issue-certificates' to the backfill reconciler", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "cron1@test.local" });
		const course = await seedCourse(ctx, { title: "Cron C1" });
		await seedEnrollment(ctx, {
			userId: student.id,
			courseId: course.id,
			completedAt: new Date().toISOString(),
		});

		await cronDispatch({ name: "issue-certificates", scheduledAt: new Date().toISOString() }, ctx);

		const certsStore = (
			ctx.storage as unknown as {
				certificates: {
					query: (opts: { where: Record<string, unknown> }) => Promise<{ items: unknown[] }>;
				};
			}
		).certificates;
		const page = await certsStore.query({ where: {} });
		expect(page.items).toHaveLength(1);
	});

	it("routes 'flush-email-queue' to the flush reconciler", async () => {
		const { ctx, outbox } = await newCtx();
		await ctx.kv.set(emailQueueKey("1"), {
			to: "cron2@test.local",
			subject: "hi",
			text: "yo",
		});

		await cronDispatch({ name: "flush-email-queue", scheduledAt: new Date().toISOString() }, ctx);

		expect(outbox).toHaveLength(1);
	});

	it("routes 'drip-release-reminders' without throwing", async () => {
		const { ctx } = await newCtx();
		await cronDispatch(
			{
				name: "drip-release-reminders",
				scheduledAt: new Date().toISOString(),
			},
			ctx,
		);
		// No enrollments seeded — reconciler should silently finish.
	});

	it("ignores unknown cron events", async () => {
		const { ctx, outbox } = await newCtx();
		await expect(
			cronDispatch({ name: "unknown-event", scheduledAt: new Date().toISOString() }, ctx),
		).resolves.toBeUndefined();
		expect(outbox).toHaveLength(0);
	});
});

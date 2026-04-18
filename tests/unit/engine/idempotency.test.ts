import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { markHandled, wasHandled } from "../../../src/engine/idempotency.js";

/**
 * Minimal ctx stub — only the surface idempotency touches (§T02 note: the
 * shared `createTestPluginCtx` helper is being built in T04 in parallel, so
 * this test stubs the KV + log methods it uses and nothing else).
 */
function stubCtx() {
	const store = new Map<string, unknown>();
	return {
		store,
		ctx: {
			kv: {
				get: async <T>(key: string): Promise<T | null> => (store.get(key) as T | undefined) ?? null,
				set: async (key: string, value: unknown): Promise<void> => {
					store.set(key, value);
				},
				delete: async (key: string): Promise<boolean> => store.delete(key),
				list: async (prefix = ""): Promise<Array<{ key: string; value: unknown }>> =>
					[...store.entries()]
						.filter(([key]) => key.startsWith(prefix))
						.map(([key, value]) => ({ key, value })),
			},
			log: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
			},
		},
	};
}

describe("idempotency", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T12:00:00Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("wasHandled() returns false when the marker has never been written", async () => {
		const { ctx } = stubCtx();

		expect(await wasHandled(ctx as never, "welcome-email", "enroll:e1")).toBe(false);
	});

	test("markHandled() writes a marker under the typed handled: key", async () => {
		const { ctx, store } = stubCtx();

		await markHandled(ctx as never, "welcome-email", "enroll:e1");

		expect(store.has("handled:welcome-email:enroll:e1")).toBe(true);
	});

	test("wasHandled() returns true after markHandled() within the 30-day window", async () => {
		const { ctx } = stubCtx();

		await markHandled(ctx as never, "welcome-email", "enroll:e1");

		expect(await wasHandled(ctx as never, "welcome-email", "enroll:e1")).toBe(true);
	});

	test("wasHandled() ignores markers older than the 30-day TTL (KV has no native TTL)", async () => {
		const { ctx } = stubCtx();

		await markHandled(ctx as never, "welcome-email", "enroll:e1");

		// Advance ~31 days forward — simulate a very stale marker.
		vi.setSystemTime(new Date("2026-05-18T12:00:01Z"));

		expect(await wasHandled(ctx as never, "welcome-email", "enroll:e1")).toBe(false);
	});

	test("wasHandled() treats markers exactly at 30 days as still live", async () => {
		const { ctx } = stubCtx();

		await markHandled(ctx as never, "welcome-email", "enroll:e1");

		vi.setSystemTime(new Date("2026-05-17T12:00:00Z"));

		expect(await wasHandled(ctx as never, "welcome-email", "enroll:e1")).toBe(true);
	});

	test("wasHandled() is robust against markers missing the `at` timestamp (legacy shape)", async () => {
		const { ctx, store } = stubCtx();

		store.set("handled:welcome-email:enroll:legacy", { somethingElse: true });

		// No `at` timestamp → treat as untrusted (cannot prove freshness) → false.
		expect(await wasHandled(ctx as never, "welcome-email", "enroll:legacy")).toBe(false);
	});

	test("different handler IDs do not collide on the same event key", async () => {
		const { ctx } = stubCtx();

		await markHandled(ctx as never, "welcome-email", "enroll:e1");

		expect(await wasHandled(ctx as never, "notify-instructor", "enroll:e1")).toBe(false);
	});
});

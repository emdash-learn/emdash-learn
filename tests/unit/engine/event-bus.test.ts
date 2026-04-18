import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
	__resetHandlersForTests,
	emit,
	on,
} from "../../../src/engine/event-bus.js";
import type { EnrollmentCreated } from "../../../src/types/engine.js";
import type { Enrollment } from "../../../src/types/storage.js";

/**
 * Minimal ctx stub — only the surface event-bus + idempotency touch (§T02
 * note: `createTestPluginCtx` is being built in T04 in parallel; we inline
 * just what we use). KV starts empty, `log.error` is a spy we assert against.
 */
function stubCtx() {
	const store = new Map<string, unknown>();
	const log = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
	return {
		store,
		log,
		ctx: {
			kv: {
				get: async <T,>(key: string): Promise<T | null> =>
					(store.get(key) as T | undefined) ?? null,
				set: async (key: string, value: unknown): Promise<void> => {
					store.set(key, value);
				},
				delete: async (key: string): Promise<boolean> => store.delete(key),
				list: async (prefix = ""): Promise<Array<{ key: string; value: unknown }>> =>
					[...store.entries()]
						.filter(([key]) => key.startsWith(prefix))
						.map(([key, value]) => ({ key, value })),
			},
			log,
		},
	};
}

const enrollment: Enrollment = {
	userId: "u_1",
	courseId: "c_1",
	enrolledAt: "2026-04-17T00:00:00Z",
	source: "free",
};

function enrollmentEvent(
	keySuffix: string,
	overrides: Partial<EnrollmentCreated> = {},
): EnrollmentCreated {
	return {
		name: "enrollment:created",
		key: `enroll:${keySuffix}`,
		data: enrollment,
		...overrides,
	};
}

describe("event-bus", () => {
	beforeEach(() => {
		__resetHandlersForTests();
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T12:00:00Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
		__resetHandlersForTests();
	});

	test("on() + emit() dispatches a registered handler exactly once", async () => {
		const { ctx } = stubCtx();
		const fn = vi.fn(async () => {});

		on("enrollment:created", "welcome-email", fn);

		await emit(enrollmentEvent("e1"), ctx as never);

		expect(fn).toHaveBeenCalledTimes(1);
		expect(fn.mock.calls[0]?.[0]).toMatchObject({ name: "enrollment:created", key: "enroll:e1" });
	});

	test("emit() writes an idempotency marker after a successful handler", async () => {
		const { ctx, store } = stubCtx();

		on("enrollment:created", "welcome-email", async () => {});
		await emit(enrollmentEvent("e1"), ctx as never);

		expect(store.has("handled:welcome-email:enroll:e1")).toBe(true);
	});

	test("emit() twice with the same event key only runs the handler once", async () => {
		const { ctx } = stubCtx();
		const fn = vi.fn(async () => {});

		on("enrollment:created", "welcome-email", fn);
		await emit(enrollmentEvent("e1"), ctx as never);
		await emit(enrollmentEvent("e1"), ctx as never);

		expect(fn).toHaveBeenCalledTimes(1);
	});

	test("emit() dispatches two different handlers for the same event independently", async () => {
		const { ctx } = stubCtx();
		const welcome = vi.fn(async () => {});
		const notify = vi.fn(async () => {});

		on("enrollment:created", "welcome-email", welcome);
		on("enrollment:created", "notify-instructor", notify);

		await emit(enrollmentEvent("e1"), ctx as never);

		expect(welcome).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledTimes(1);
	});

	test("per-handler idempotency: only the previously-run handler is skipped on re-emit", async () => {
		const { ctx, store } = stubCtx();
		const welcome = vi.fn(async () => {});
		const notify = vi.fn(async () => {});

		on("enrollment:created", "welcome-email", welcome);
		on("enrollment:created", "notify-instructor", notify);

		// First pass: only welcome is registered, so only welcome's marker exists.
		store.set("handled:welcome-email:enroll:e1", { at: Date.now() });

		await emit(enrollmentEvent("e1"), ctx as never);

		expect(welcome).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	test("non-critical handler failures are logged and swallowed; marker NOT written", async () => {
		const { ctx, store, log } = stubCtx();

		on("enrollment:created", "welcome-email", async () => {
			throw new Error("email provider down");
		});

		await expect(emit(enrollmentEvent("e1"), ctx as never)).resolves.toBeUndefined();

		expect(log.error).toHaveBeenCalledTimes(1);
		expect(store.has("handled:welcome-email:enroll:e1")).toBe(false);
	});

	test("critical handler failures propagate to the caller", async () => {
		const { ctx } = stubCtx();

		on("enrollment:created", "write-enrollment-row", async () => {
			throw new Error("db failure");
		});

		await expect(
			emit(enrollmentEvent("e1", { critical: true }), ctx as never),
		).rejects.toThrow("db failure");
	});

	test("critical handler failures do not write the idempotency marker", async () => {
		const { ctx, store } = stubCtx();

		on("enrollment:created", "write-enrollment-row", async () => {
			throw new Error("db failure");
		});

		await expect(
			emit(enrollmentEvent("e1", { critical: true }), ctx as never),
		).rejects.toThrow("db failure");

		expect(store.has("handled:write-enrollment-row:enroll:e1")).toBe(false);
	});

	test("emit() with no registered handlers is a no-op", async () => {
		const { ctx, log } = stubCtx();

		await expect(emit(enrollmentEvent("e1"), ctx as never)).resolves.toBeUndefined();

		expect(log.error).not.toHaveBeenCalled();
	});
});

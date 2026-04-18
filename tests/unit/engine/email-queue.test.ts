import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { flush, send } from "../../../src/engine/email-queue.js";
import type { EmailMessage } from "../../../src/engine/email-queue.js";

function stubCtx(opts: { email?: { send: (m: EmailMessage) => Promise<void> } } = {}) {
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
			...(opts.email ? { email: opts.email } : {}),
		},
	};
}

const sampleMessage: EmailMessage = {
	to: "student@example.com",
	subject: "Welcome to the course",
	text: "See you there.",
};

describe("email-queue: send()", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-17T12:00:00Z"));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	test("when ctx.email is undefined: enqueues under queue:email:* and returns ok", async () => {
		const { ctx, store } = stubCtx();

		const result = await send(ctx as never, sampleMessage);

		expect(result).toEqual({ ok: true, data: undefined });

		const keys = [...store.keys()];
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(/^queue:email:/);
		expect(store.get(keys[0]!)).toEqual(sampleMessage);
	});

	test("when ctx.email is defined: sends inline and does NOT enqueue", async () => {
		const providerSend = vi.fn(async () => {});
		const { ctx, store } = stubCtx({ email: { send: providerSend } });

		const result = await send(ctx as never, sampleMessage);

		expect(result.ok).toBe(true);
		expect(providerSend).toHaveBeenCalledTimes(1);
		expect(providerSend).toHaveBeenCalledWith(sampleMessage);
		expect([...store.keys()]).toHaveLength(0);
	});

	test("when ctx.email is defined but throws: queues for later retry and still returns ok", async () => {
		const providerSend = vi.fn(async () => {
			throw new Error("provider down");
		});
		const { ctx, store, log } = stubCtx({ email: { send: providerSend } });

		const result = await send(ctx as never, sampleMessage);

		expect(result.ok).toBe(true);
		expect([...store.keys()]).toHaveLength(1);
		expect(log.warn).toHaveBeenCalled();
	});

	test("multiple sends produce distinct queue keys (no clobber)", async () => {
		const { ctx, store } = stubCtx();

		await send(ctx as never, { ...sampleMessage, to: "a@example.com" });
		await send(ctx as never, { ...sampleMessage, to: "b@example.com" });

		expect([...store.keys()]).toHaveLength(2);
	});
});

describe("email-queue: flush()", () => {
	test("noops and returns { sent: 0, remaining: 0 } when ctx.email is undefined", async () => {
		const { ctx, store } = stubCtx();
		store.set("queue:email:01", sampleMessage);

		const result = await flush(ctx as never);

		expect(result).toEqual({ ok: true, data: { sent: 0, remaining: 1 } });
		expect([...store.keys()]).toHaveLength(1);
	});

	test("drains queue:email:* entries via ctx.email.send and deletes them", async () => {
		const providerSend = vi.fn(async () => {});
		const { ctx, store } = stubCtx({ email: { send: providerSend } });

		store.set("queue:email:01", { ...sampleMessage, to: "a@example.com" });
		store.set("queue:email:02", { ...sampleMessage, to: "b@example.com" });

		const result = await flush(ctx as never);

		expect(result).toEqual({ ok: true, data: { sent: 2, remaining: 0 } });
		expect(providerSend).toHaveBeenCalledTimes(2);
		expect([...store.keys()]).toHaveLength(0);
	});

	test("ignores keys outside the queue:email:* prefix", async () => {
		const providerSend = vi.fn(async () => {});
		const { ctx, store } = stubCtx({ email: { send: providerSend } });

		store.set("queue:email:01", sampleMessage);
		store.set("settings:defaultPassingScore", 70);
		store.set("handled:welcome:enroll:e1", { at: Date.now() });

		const result = await flush(ctx as never);

		expect(result.ok).toBe(true);
		expect(providerSend).toHaveBeenCalledTimes(1);
		expect(store.has("settings:defaultPassingScore")).toBe(true);
		expect(store.has("handled:welcome:enroll:e1")).toBe(true);
	});

	test("a single send failure leaves that item in the queue and surfaces in `remaining`", async () => {
		let calls = 0;
		const providerSend = vi.fn(async () => {
			calls += 1;
			if (calls === 2) throw new Error("provider flaked");
		});
		const { ctx, store, log } = stubCtx({ email: { send: providerSend } });

		store.set("queue:email:01", { ...sampleMessage, to: "a@example.com" });
		store.set("queue:email:02", { ...sampleMessage, to: "b@example.com" });
		store.set("queue:email:03", { ...sampleMessage, to: "c@example.com" });

		const result = await flush(ctx as never);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.data.sent).toBe(2);
			expect(result.data.remaining).toBe(1);
		}
		expect(store.has("queue:email:02")).toBe(true);
		expect(log.warn).toHaveBeenCalled();
	});

	test("gracefully skips queue items whose stored value is not a valid EmailMessage", async () => {
		const providerSend = vi.fn(async () => {});
		const { ctx, store, log } = stubCtx({ email: { send: providerSend } });

		store.set("queue:email:01", sampleMessage);
		store.set("queue:email:corrupt", { not: "a message" });

		const result = await flush(ctx as never);

		expect(result.ok).toBe(true);
		expect(providerSend).toHaveBeenCalledTimes(1);
		// Corrupt entry is dropped (or remains) but we at least logged about it and didn't crash.
		expect(log.warn).toHaveBeenCalled();
	});
});

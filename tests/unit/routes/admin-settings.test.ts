/**
 * Unit tests for `src/routes/admin-settings.ts` (T24 / §16.8).
 *
 *   - Route table contains exactly the three §16.8 names and each has a handler.
 *   - `admin:settings:get` returns the defaults for a fresh install and
 *     overlays KV writes on top.
 *   - `admin:settings:update` validates the patch, writes only supplied keys,
 *     and rejects unknown keys + out-of-range numbers.
 *   - `admin:test-email` delegates to `ctx.email.send` when a provider is
 *     configured, and falls back to the queue when it isn't.
 *   - ADMIN role gating is enforced on all three routes (EDITOR + unauth).
 *
 * The route handlers only touch `ctx.kv`, `ctx.email`, and `ctx.log`, so we
 * stub those directly instead of spinning up the full SQLite ctx.
 */

import { describe, expect, it, vi } from "vitest";

import { Role } from "../../../src/authz.js";
import { BOOTSTRAP_VERSION, DEFAULT_SETTINGS, LEARN_ERRORS, SETTING_KEYS } from "../../../src/constants.js";
import type { EmailMessage } from "../../../src/engine/email-queue.js";
import { BOOTSTRAP_STATE_KEY } from "../../../src/kv-keys.js";
import { adminSettingsRoutes } from "../../../src/routes/admin-settings.js";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface MakeCtxOpts {
	roleLevel?: number;
	email?: { send: (m: EmailMessage) => Promise<void> };
	/** Seed KV before the call. Useful for testing `get` overlays. */
	kv?: Record<string, unknown>;
}

function makeCtx(opts: MakeCtxOpts = {}) {
	// Seed the bootstrap state so `ensureSetupComplete` passes in unit tests.
	// Tests that explicitly want an incomplete state can override this key.
	const defaultKv: Record<string, unknown> = {
		[BOOTSTRAP_STATE_KEY]: { version: BOOTSTRAP_VERSION, completedSteps: [] },
	};
	const store = new Map<string, unknown>(Object.entries({ ...defaultKv, ...opts.kv }));
	const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const user =
		opts.roleLevel === undefined
			? {
					id: "u_admin",
					email: "admin@example.com",
					name: "Admin",
					role: Role.ADMIN,
					createdAt: "",
				}
			: {
					id: "u_test",
					email: "t@example.com",
					name: "T",
					role: opts.roleLevel,
					createdAt: "",
				};

	const kv = {
		async get<T>(key: string): Promise<T | null> {
			return (store.get(key) as T | undefined) ?? null;
		},
		async set(key: string, value: unknown): Promise<void> {
			store.set(key, value);
		},
		async delete(key: string): Promise<boolean> {
			return store.delete(key);
		},
		async list(prefix = ""): Promise<Array<{ key: string; value: unknown }>> {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, value]) => ({ key, value }));
		},
	};

	function buildRouteCtx(input: unknown) {
		return {
			input,
			kv,
			log,
			user,
			...(opts.email ? { email: opts.email } : {}),
		} as unknown as Parameters<(typeof adminSettingsRoutes)["admin:settings:get"]["handler"]>[0];
	}

	return { store, log, user, buildRouteCtx };
}

// ---------------------------------------------------------------------------
// Route table shape
// ---------------------------------------------------------------------------

describe("adminSettingsRoutes table", () => {
	it("exports exactly the three §16.8 route names", () => {
		expect(Object.keys(adminSettingsRoutes).sort()).toEqual([
			"admin:settings:get",
			"admin:settings:update",
			"admin:test-email",
		]);
	});

	it("each route has an async handler", () => {
		for (const [, route] of Object.entries(adminSettingsRoutes)) {
			expect(typeof route.handler).toBe("function");
		}
	});
});

// ---------------------------------------------------------------------------
// admin:settings:get
// ---------------------------------------------------------------------------

describe("admin:settings:get", () => {
	it("returns DEFAULT_SETTINGS for a fresh install and emailProvider.configured=false", async () => {
		const { buildRouteCtx } = makeCtx();
		const route = adminSettingsRoutes["admin:settings:get"];
		const result = (await route.handler(buildRouteCtx({}))) as {
			settings: Record<string, unknown>;
			emailProvider: { configured: boolean; queued: number };
		};

		for (const key of SETTING_KEYS) {
			expect(result.settings[key]).toEqual(DEFAULT_SETTINGS[key]);
		}
		expect(result.emailProvider).toEqual({ configured: false, queued: 0 });
	});

	it("overlays KV overrides on top of defaults", async () => {
		const { buildRouteCtx } = makeCtx({
			kv: {
				"settings:siteName": "Acme Academy",
				"settings:defaultPassingScore": 85,
				"settings:certificateExpiryDays": 365,
			},
		});
		const route = adminSettingsRoutes["admin:settings:get"];
		const result = (await route.handler(buildRouteCtx({}))) as {
			settings: Record<string, unknown>;
		};
		expect(result.settings.siteName).toBe("Acme Academy");
		expect(result.settings.defaultPassingScore).toBe(85);
		expect(result.settings.certificateExpiryDays).toBe(365);
		// A key that wasn't overridden still returns the default.
		expect(result.settings.dripMode).toBe(DEFAULT_SETTINGS.dripMode);
	});

	it("reverts drifted KV value to default and warns (M10)", async () => {
		const { buildRouteCtx, log } = makeCtx({
			kv: { "settings:dripMode": 42 }, // stored as number — invalid shape
		});
		const route = adminSettingsRoutes["admin:settings:get"];
		const result = (await route.handler(buildRouteCtx({}))) as {
			settings: Record<string, unknown>;
		};
		expect(result.settings.dripMode).toBe(DEFAULT_SETTINGS.dripMode);
		expect(log.warn).toHaveBeenCalledOnce();
		expect(String(log.warn.mock.calls[0]?.[0])).toMatch(/dripMode/);
	});

	it("surfaces provider=true when ctx.email is present and counts queued emails", async () => {
		const { buildRouteCtx } = makeCtx({
			email: { send: vi.fn(async () => {}) },
			kv: {
				"queue:email:0001": { to: "a@x", subject: "s", text: "t" },
				"queue:email:0002": { to: "b@x", subject: "s", text: "t" },
			},
		});
		const route = adminSettingsRoutes["admin:settings:get"];
		const result = (await route.handler(buildRouteCtx({}))) as {
			emailProvider: { configured: boolean; queued: number };
		};
		expect(result.emailProvider).toEqual({ configured: true, queued: 2 });
	});

	it("rejects EDITOR (below ADMIN) with FORBIDDEN", async () => {
		const { buildRouteCtx } = makeCtx({ roleLevel: Role.EDITOR });
		const route = adminSettingsRoutes["admin:settings:get"];
		await expect(route.handler(buildRouteCtx({}))).rejects.toMatchObject({
			code: LEARN_ERRORS.FORBIDDEN,
		});
	});

	it("rejects an unauthenticated caller with UNAUTHENTICATED", async () => {
		const { buildRouteCtx } = makeCtx();
		const ctx = buildRouteCtx({});
		(ctx as { user: unknown }).user = null;
		const route = adminSettingsRoutes["admin:settings:get"];
		await expect(route.handler(ctx)).rejects.toMatchObject({
			code: LEARN_ERRORS.UNAUTHENTICATED,
		});
	});
});

// ---------------------------------------------------------------------------
// admin:settings:update
// ---------------------------------------------------------------------------

describe("admin:settings:update", () => {
	it("writes only the provided keys and returns the merged view", async () => {
		const { buildRouteCtx, store } = makeCtx();
		const route = adminSettingsRoutes["admin:settings:update"];
		const input = route.input!.parse({
			settings: { siteName: "Acme", defaultPassingScore: 90 },
		});
		const result = (await route.handler(buildRouteCtx(input))) as {
			settings: Record<string, unknown>;
		};

		expect(store.get("settings:siteName")).toBe("Acme");
		expect(store.get("settings:defaultPassingScore")).toBe(90);
		expect(store.has("settings:dripMode")).toBe(false);
		expect(result.settings.siteName).toBe("Acme");
		expect(result.settings.defaultPassingScore).toBe(90);
		// Unchanged keys still come back as defaults.
		expect(result.settings.dripMode).toBe(DEFAULT_SETTINGS.dripMode);
	});

	it("accepts certificateExpiryDays: null (never expires)", async () => {
		const { buildRouteCtx, store } = makeCtx({
			kv: { "settings:certificateExpiryDays": 365 },
		});
		const route = adminSettingsRoutes["admin:settings:update"];
		const input = route.input!.parse({
			settings: { certificateExpiryDays: null },
		});
		const result = (await route.handler(buildRouteCtx(input))) as {
			settings: Record<string, unknown>;
		};
		expect(store.get("settings:certificateExpiryDays")).toBeNull();
		expect(result.settings.certificateExpiryDays).toBeNull();
	});

	it("rejects unknown keys at the input boundary", () => {
		const route = adminSettingsRoutes["admin:settings:update"];
		expect(() => route.input!.parse({ settings: { bogus: "x" } })).toThrow();
	});

	it("rejects defaultPassingScore out of range", () => {
		const route = adminSettingsRoutes["admin:settings:update"];
		expect(() => route.input!.parse({ settings: { defaultPassingScore: 101 } })).toThrow();
		expect(() => route.input!.parse({ settings: { defaultPassingScore: -1 } })).toThrow();
	});

	it("rejects a negative certificateExpiryDays", () => {
		const route = adminSettingsRoutes["admin:settings:update"];
		expect(() => route.input!.parse({ settings: { certificateExpiryDays: -5 } })).toThrow();
	});

	it("allows supportEmail to be cleared to empty string", async () => {
		const { buildRouteCtx, store } = makeCtx();
		const route = adminSettingsRoutes["admin:settings:update"];
		const input = route.input!.parse({ settings: { supportEmail: "" } });
		await route.handler(buildRouteCtx(input));
		expect(store.get("settings:supportEmail")).toBe("");
	});

	it("rejects EDITOR with FORBIDDEN", async () => {
		const { buildRouteCtx } = makeCtx({ roleLevel: Role.EDITOR });
		const route = adminSettingsRoutes["admin:settings:update"];
		const input = route.input!.parse({ settings: {} });
		await expect(route.handler(buildRouteCtx(input))).rejects.toMatchObject({
			code: LEARN_ERRORS.FORBIDDEN,
		});
	});
});

// ---------------------------------------------------------------------------
// admin:test-email
// ---------------------------------------------------------------------------

describe("admin:test-email", () => {
	it("delivers inline when ctx.email is configured and returns delivered=true", async () => {
		const send = vi.fn(async () => {});
		const { buildRouteCtx, store } = makeCtx({ email: { send } });
		const route = adminSettingsRoutes["admin:test-email"];
		const input = route.input!.parse({});
		const result = (await route.handler(buildRouteCtx(input))) as {
			delivered: boolean;
			to: string;
		};

		expect(result.delivered).toBe(true);
		expect(result.to).toBe("admin@example.com");
		expect(send).toHaveBeenCalledTimes(1);
		// Nothing landed in the queue.
		expect([...store.keys()].filter((k) => k.startsWith("queue:email:"))).toHaveLength(0);
	});

	it("queues the message when no provider is configured and returns delivered=false", async () => {
		const { buildRouteCtx, store } = makeCtx();
		const route = adminSettingsRoutes["admin:test-email"];
		const input = route.input!.parse({});
		const result = (await route.handler(buildRouteCtx(input))) as {
			delivered: boolean;
			to: string;
		};

		expect(result.delivered).toBe(false);
		expect(result.to).toBe("admin@example.com");
		const queued = [...store.keys()].filter((k) => k.startsWith("queue:email:"));
		expect(queued).toHaveLength(1);
	});

	it("honors an explicit `to` override", async () => {
		const send = vi.fn(async () => {});
		const { buildRouteCtx } = makeCtx({ email: { send } });
		const route = adminSettingsRoutes["admin:test-email"];
		const input = route.input!.parse({ to: "tester@example.com" });
		const result = (await route.handler(buildRouteCtx(input))) as { to: string };
		expect(result.to).toBe("tester@example.com");
		expect(send.mock.calls[0]?.[0]).toMatchObject({ to: "tester@example.com" });
	});

	it("rejects a non-email `to` at the input boundary", () => {
		const route = adminSettingsRoutes["admin:test-email"];
		expect(() => route.input!.parse({ to: "not-an-email" })).toThrow();
	});

	it("rejects EDITOR with FORBIDDEN", async () => {
		const { buildRouteCtx } = makeCtx({ roleLevel: Role.EDITOR });
		const route = adminSettingsRoutes["admin:test-email"];
		const input = route.input!.parse({});
		await expect(route.handler(buildRouteCtx(input))).rejects.toMatchObject({
			code: LEARN_ERRORS.FORBIDDEN,
		});
	});
});

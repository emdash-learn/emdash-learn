/**
 * Integration tests for the bootstrap setup gate (AUDIT C5).
 *
 * Acceptance criteria:
 *   1. BootstrapState.version = 0 → calling a data route (catalog) throws
 *      LEARN_SETUP_INCOMPLETE with status 409 and a structured `details`
 *      payload containing `setupPath`.
 *   2. BootstrapState.version = BOOTSTRAP_VERSION → calling catalog returns
 *      a normal empty response (no throw).
 *
 * The test manipulates the bootstrap KV record directly via `ctx.kv.set` to
 * simulate pre-wizard and post-wizard state without running the full wizard.
 */

import { afterEach, describe, expect, it } from "vitest";

import { catalogRoutes } from "../../../src/routes/public-catalog.js";
import { enrollmentRoutes } from "../../../src/routes/student-enrollments.js";
import { LEARN_ERRORS, BOOTSTRAP_VERSION } from "../../../src/constants.js";
import { BOOTSTRAP_STATE_KEY } from "../../../src/kv-keys.js";
import { createTestPluginCtx } from "../../utils/test-plugin-ctx.js";
import type { BootstrapState } from "../../../src/types/storage.js";

type TestCtx = Awaited<ReturnType<typeof createTestPluginCtx>>;

const contexts: TestCtx[] = [];

async function newCtx(opts: Parameters<typeof createTestPluginCtx>[0] = {}): Promise<TestCtx> {
	const ctx = await createTestPluginCtx(opts);
	contexts.push(ctx);
	return ctx;
}

afterEach(async () => {
	const pending = contexts.splice(0, contexts.length);
	await Promise.all(pending.map((ctx) => ctx.teardown()));
});

function makeRouteCtx(fixture: TestCtx, input: unknown) {
	return { ...fixture.ctx, user: fixture.user, input };
}

async function setBootstrapVersion(fixture: TestCtx, version: number): Promise<void> {
	const state: BootstrapState = { version, completedSteps: [] };
	await fixture.ctx.kv.set(BOOTSTRAP_STATE_KEY, state);
}

describe("setup gate (AUDIT C5)", () => {
	it("catalog route with version=0 → LEARN_SETUP_INCOMPLETE, status 409, setupPath in details", async () => {
		const fixture = await newCtx();
		// Force bootstrap version to 0 (pre-wizard state).
		await setBootstrapVersion(fixture, 0);

		const route = catalogRoutes.catalog;
		const err = await route.handler(makeRouteCtx(fixture, {}) as never).catch((e) => e);

		expect(err).toBeDefined();
		expect(err.name).toBe("PluginRouteError");
		expect(err.code).toBe(LEARN_ERRORS.SETUP_INCOMPLETE);
		expect(err.status).toBe(409);
		expect(err.details).toMatchObject({
			setupPath: "/_emdash/admin/plugins/lms-core/setup",
		});
	});

	it("catalog route with version=BOOTSTRAP_VERSION → normal empty response (no throw)", async () => {
		const fixture = await newCtx();
		// Force bootstrap version to match target (post-wizard state).
		await setBootstrapVersion(fixture, BOOTSTRAP_VERSION);

		const route = catalogRoutes.catalog;
		const result = (await route.handler(makeRouteCtx(fixture, {}) as never)) as {
			items: unknown[];
			hasMore: boolean;
		};

		expect(result).toBeDefined();
		expect(Array.isArray(result.items)).toBe(true);
		expect(result.hasMore).toBe(false);
	});

	it("enroll route with version=0 → LEARN_SETUP_INCOMPLETE, status 409", async () => {
		const fixture = await newCtx({
			user: { id: "u_student", email: "student@test.local", role: 10 },
		});
		await setBootstrapVersion(fixture, 0);

		const route = enrollmentRoutes.enroll;
		const err = await route
			.handler(
				makeRouteCtx(fixture, {
					courseId: "course_1",
					source: "free",
				}) as never,
			)
			.catch((e) => e);

		expect(err.name).toBe("PluginRouteError");
		expect(err.code).toBe(LEARN_ERRORS.SETUP_INCOMPLETE);
		expect(err.status).toBe(409);
		expect(err.details).toMatchObject({
			setupPath: "/_emdash/admin/plugins/lms-core/setup",
		});
	});

	it("error message contains the bootstrap version numbers", async () => {
		const fixture = await newCtx();
		await setBootstrapVersion(fixture, 1);

		const route = catalogRoutes.catalog;
		const err = await route.handler(makeRouteCtx(fixture, {}) as never).catch((e) => e);

		expect(err.message).toContain("1");
		expect(err.message).toContain(String(BOOTSTRAP_VERSION));
	});
});

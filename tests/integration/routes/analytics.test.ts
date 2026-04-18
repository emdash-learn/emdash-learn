/**
 * Route-level smoke tests for analytics (T15).
 *
 * Covers gate enforcement + happy-path shape for the instructor and admin
 * analytics route modules. The engine-level coverage lives alongside
 * `tests/integration/engine/analytics.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { PluginRouteError } from "emdash";
import { ulid } from "emdash";

import { adminAnalyticsRoutes } from "../../../src/routes/admin-analytics.js";
import { instructorAnalyticsRoutes } from "../../../src/routes/instructor-analytics.js";
import { LEARN_ERRORS } from "../../../src/constants.js";
import { seedCourse } from "../../utils/seed.js";
import { createTestPluginCtx } from "../../utils/test-plugin-ctx.js";

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

/**
 * Wrap the raw `ctx` from the fixture with `user` + `input`, matching the
 * shape emdash passes to plugin route handlers.
 */
function makeRouteCtx(fixture: TestCtx, input: unknown) {
	return { ...fixture.ctx, user: fixture.user, input };
}

async function assignInstructor(
	ctx: TestCtx["ctx"],
	courseId: string,
	userId: string,
): Promise<void> {
	// eslint-disable-next-line typescript-eslint/no-explicit-any
	await (ctx.storage as any).course_instructors.put(`ci_${ulid()}`, {
		courseId,
		userId,
		role: "lead",
	});
}

describe("instructor-analytics routes gating", () => {
	it("instructor:dashboard-stats as SUBSCRIBER → LEARN_FORBIDDEN", async () => {
		const fixture = await newCtx({
			user: { id: "u_sub", email: "sub@test.local", role: 10 },
		});
		const route = instructorAnalyticsRoutes["instructor:dashboard-stats"];
		await expect(
			// eslint-disable-next-line typescript-eslint/no-explicit-any
			route.handler(makeRouteCtx(fixture, {}) as any),
		).rejects.toMatchObject({
			name: "PluginRouteError",
			code: LEARN_ERRORS.FORBIDDEN,
		});
	});

	it("instructor:dashboard-stats as EDITOR → returns shape", async () => {
		const fixture = await newCtx({
			user: { id: "u_ed", email: "ed@test.local", role: 40 },
		});
		const route = instructorAnalyticsRoutes["instructor:dashboard-stats"];
		// eslint-disable-next-line typescript-eslint/no-explicit-any
		const result = await route.handler(makeRouteCtx(fixture, {}) as any);
		expect(result).toEqual({
			totalStudents: 0,
			active30d: 0,
			avgCompletion: 0,
			quizPassRate: 0,
		});
	});

	it("instructor:course-overview without instructor row → LEARN_NOT_INSTRUCTOR", async () => {
		const fixture = await newCtx({
			user: { id: "u_ed2", email: "ed2@test.local", role: 40 },
		});
		const course = await seedCourse(fixture.ctx, { title: "NA" });
		const route = instructorAnalyticsRoutes["instructor:course-overview"];
		await expect(
			route.handler(
				// eslint-disable-next-line typescript-eslint/no-explicit-any
				makeRouteCtx(fixture, { courseId: course.id }) as any,
			),
		).rejects.toBeInstanceOf(PluginRouteError);
		try {
			// eslint-disable-next-line typescript-eslint/no-explicit-any
			await route.handler(makeRouteCtx(fixture, { courseId: course.id }) as any);
		} catch (e) {
			expect((e as PluginRouteError).code).toBe(LEARN_ERRORS.NOT_INSTRUCTOR);
		}
	});

	it("instructor:course-overview as assigned EDITOR → returns shape", async () => {
		const fixture = await newCtx({
			user: { id: "u_ed3", email: "ed3@test.local", role: 40 },
		});
		const course = await seedCourse(fixture.ctx, { title: "Mine" });
		await assignInstructor(fixture.ctx, course.id, fixture.user.id);
		const route = instructorAnalyticsRoutes["instructor:course-overview"];
		const result = await route.handler(
			// eslint-disable-next-line typescript-eslint/no-explicit-any
			makeRouteCtx(fixture, { courseId: course.id }) as any,
		);
		expect(result).toMatchObject({
			courseId: course.id,
			enrolled: expect.any(Number),
			completed: expect.any(Number),
		});
	});
});

describe("admin-analytics routes gating", () => {
	const range = {
		from: new Date(Date.now() - 86_400_000).toISOString(),
		to: new Date(Date.now() + 86_400_000).toISOString(),
	};

	it("admin:analytics-overview as EDITOR → LEARN_FORBIDDEN", async () => {
		const fixture = await newCtx({
			user: { id: "u_ed4", email: "ed4@test.local", role: 40 },
		});
		const route = adminAnalyticsRoutes["admin:analytics-overview"];
		await expect(
			// eslint-disable-next-line typescript-eslint/no-explicit-any
			route.handler(makeRouteCtx(fixture, { range }) as any),
		).rejects.toMatchObject({
			name: "PluginRouteError",
			code: LEARN_ERRORS.FORBIDDEN,
		});
	});

	it("admin:analytics-overview as ADMIN → returns shape", async () => {
		const fixture = await newCtx({
			user: { id: "u_ad", email: "admin@test.local", role: 50 },
		});
		const route = adminAnalyticsRoutes["admin:analytics-overview"];
		// eslint-disable-next-line typescript-eslint/no-explicit-any
		const result = await route.handler(makeRouteCtx(fixture, { range }) as any);
		expect(result).toMatchObject({
			totalEnrollments: expect.any(Number),
			totalCompletions: expect.any(Number),
			activeUsers30d: expect.any(Number),
			certificatesIssued: expect.any(Number),
		});
	});
});

import { describe, expect, it, vi } from "vitest";
import { PluginRouteError } from "emdash";

import type { EngagementReporting } from "../../../src/modules/engagement-reporting/index.js";
import {
	createEngagementReportingRoutes,
	publicEngagementObservationInput,
} from "../../../src/routes/engagement-reporting.js";
import { PublicRateLimitError } from "../../../src/security/public-rate-limit.js";
import { createRouteContext } from "../../utils/route-context.js";

function reporting(overrides: Partial<EngagementReporting> = {}): EngagementReporting {
	return {
		async observe() {},
		async query() {
			return { calculatedThrough: null, courses: [] };
		},
		async pruneExpired() {
			return { observationsPruned: 0 };
		},
		...overrides,
	};
}

describe("Engagement Reporting routes", () => {
	it("accepts only allowlisted browser observations with no arbitrary properties", () => {
		expect(
			publicEngagementObservationInput.safeParse({
				type: "lesson_opened",
				courseId: "course-typescript",
				lessonId: "lesson-types",
			}).success,
		).toBe(true);
		expect(
			publicEngagementObservationInput.safeParse({
				type: "lesson_completed",
				courseId: "course-typescript",
				lessonId: "lesson-types",
			}).success,
		).toBe(false);
		expect(
			publicEngagementObservationInput.safeParse({
				type: "course_opened",
				courseId: "course-typescript",
				email: "copied@example.test",
			}).success,
		).toBe(false);
	});

	it("records public observations without an identity field", async () => {
		const observe = vi.fn(async () => {});
		const beforePublicObservation = vi.fn(async () => {});
		const routes = createEngagementReportingRoutes({
			createReporting: () => reporting({ observe }),
			beforePublicObservation,
		});

		await routes["engagement:observe"].handler(
			createRouteContext({ type: "course_opened", courseId: "course-typescript" } as const, {
				principal: null,
			}),
		);
		await routes["engagement:observe"].handler(
			createRouteContext(
				{
					type: "check_opened",
					courseId: "course-typescript",
					checkId: "check-types",
				} as const,
				{ principal: { id: "core-user-42" } },
			),
		);

		expect(observe).toHaveBeenNthCalledWith(1, {
			type: "course_opened",
			courseId: "course-typescript",
		});
		expect(observe).toHaveBeenNthCalledWith(2, {
			type: "check_opened",
			courseId: "course-typescript",
			checkId: "check-types",
		});
		expect(beforePublicObservation).toHaveBeenCalledTimes(2);
		expect(routes["engagement:observe"].public).toBe(true);
	});

	it("keeps reporting queries administrator-only", async () => {
		const query = vi.fn(async () => ({ calculatedThrough: null, courses: [] }));
		const routes = createEngagementReportingRoutes({
			createReporting: () => reporting({ query }),
			beforePublicObservation: async () => {},
		});

		await routes["reporting:query"].handler(
			createRouteContext({
				from: "2026-07-26T00:00:00.000Z",
				to: "2026-07-27T00:00:00.000Z",
			}),
		);

		expect(query).toHaveBeenCalledOnce();
		expect(routes["reporting:query"].permission).toBe("plugins:manage");
	});

	it("maps public abuse limits to a transport-safe 429", async () => {
		const routes = createEngagementReportingRoutes({
			createReporting: () => reporting(),
			beforePublicObservation: async () => {
				throw new PublicRateLimitError();
			},
		});

		const rejection = routes["engagement:observe"].handler(
			createRouteContext({
				type: "course_opened",
				courseId: "course-typescript",
			}),
		);
		await expect(rejection).rejects.toBeInstanceOf(PluginRouteError);
		await expect(rejection).rejects.toMatchObject({
			code: "LEARN_RATE_LIMITED",
			status: 429,
		});
	});
});

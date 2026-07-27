import { describe, expect, it, vi } from "vitest";
import { PluginRouteError } from "emdash";

import type { PrivacyErasure, PrivacyErasureResult } from "../../../src/modules/privacy-erasure.js";
import { PrivacyErasureError } from "../../../src/modules/privacy-erasure.js";
import {
	createPrivacyErasureRoutes,
	privacyEraseMyDataInput,
} from "../../../src/routes/privacy-erasure.js";
import { createRouteContext } from "../../utils/route-context.js";

const erased: PrivacyErasureResult = {
	deleted: {
		lessonCompletions: 3,
		assessmentAttempts: 2,
		rawEngagementObservations: 5,
	},
};

describe("Privacy Erasure route", () => {
	it("derives the learner from the core principal and erases only that learner's data", async () => {
		const eraseMyData = vi.fn(async () => erased);
		const routes = createPrivacyErasureRoutes({
			createPrivacyErasure: (): PrivacyErasure => ({ eraseMyData }),
		});

		const result = await routes["privacy:erase-my-data"].handler(
			createRouteContext({}, { principal: { id: "core-user-42" } }),
		);

		expect({
			result,
			learner: eraseMyData.mock.calls[0]?.[0],
			permission: routes["privacy:erase-my-data"].permission,
		}).toEqual({
			result: erased,
			learner: { kind: "verified", learnerId: "core-user-42" },
			permission: "content:read",
		});
	});

	it("rejects caller-supplied identity and an absent core principal before creating the domain", async () => {
		const createPrivacyErasure = vi.fn(
			(): PrivacyErasure => ({
				async eraseMyData() {
					return erased;
				},
			}),
		);
		const routes = createPrivacyErasureRoutes({ createPrivacyErasure });
		const rejection = routes["privacy:erase-my-data"].handler(
			createRouteContext({}, { principal: null }),
		);

		expect(
			privacyEraseMyDataInput.safeParse({
				learnerId: "attacker-selected",
			}).success,
		).toBe(false);
		await expect(rejection).rejects.toBeInstanceOf(PluginRouteError);
		await expect(rejection).rejects.toMatchObject({
			code: "LEARN_UNAUTHENTICATED",
			status: 401,
		});
		expect(createPrivacyErasure).not.toHaveBeenCalled();
	});

	it("accepts only POST requests", async () => {
		const createPrivacyErasure = vi.fn(
			(): PrivacyErasure => ({
				async eraseMyData() {
					return erased;
				},
			}),
		);
		const routes = createPrivacyErasureRoutes({ createPrivacyErasure });

		await expect(
			routes["privacy:erase-my-data"].handler(
				createRouteContext(
					{},
					{
						principal: { id: "core-user-42" },
						method: "GET",
					},
				),
			),
		).rejects.toMatchObject({
			name: "PluginRouteError",
			code: "LEARN_METHOD_NOT_ALLOWED",
			status: 405,
		});
		expect(createPrivacyErasure).not.toHaveBeenCalled();
	});

	it("maps a typed partial-erasure failure to a safe plugin route error", async () => {
		const routes = createPrivacyErasureRoutes({
			createPrivacyErasure: (): PrivacyErasure => ({
				async eraseMyData() {
					throw new PrivacyErasureError(["assessmentAttempts"], {
						lessonCompletions: 3,
						assessmentAttempts: 0,
						rawEngagementObservations: 5,
					});
				},
			}),
		});

		const rejection = routes["privacy:erase-my-data"].handler(
			createRouteContext({}, { principal: { id: "core-user-42" } }),
		);

		await expect(rejection).rejects.toBeInstanceOf(PluginRouteError);
		await expect(rejection).rejects.toMatchObject({
			code: "LEARN_PRIVACY_ERASURE_FAILED",
			status: 500,
			message: "Some learner data could not be erased. The request can be retried safely.",
			details: {
				failedCategories: ["assessmentAttempts"],
				deleted: {
					lessonCompletions: 3,
					assessmentAttempts: 0,
					rawEngagementObservations: 5,
				},
			},
		});
	});
});

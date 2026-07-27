import { describe, expect, it, vi } from "vitest";

import { createPrivacyErasure } from "../../../src/modules/privacy-erasure.js";

describe("Privacy Erasure", () => {
	it("erases every attributable learner-data category", async () => {
		const eraseCompletions = vi.fn(async () => 3);
		const eraseAttempts = vi.fn(async () => 2);
		const eraseRawObservations = vi.fn(async () => 5);
		const privacy = createPrivacyErasure({
			lessonCompletions: { erase: eraseCompletions },
			assessmentAttempts: { erase: eraseAttempts },
			rawEngagementObservations: { erase: eraseRawObservations },
		});
		const learner = { kind: "verified" as const, learnerId: "core-user-42" };

		const result = await privacy.eraseMyData(learner);

		expect({
			result,
			learners: [
				eraseCompletions.mock.calls[0]?.[0],
				eraseAttempts.mock.calls[0]?.[0],
				eraseRawObservations.mock.calls[0]?.[0],
			],
		}).toEqual({
			result: {
				deleted: {
					lessonCompletions: 3,
					assessmentAttempts: 2,
					rawEngagementObservations: 5,
				},
			},
			learners: [learner, learner, learner],
		});
	});

	it("attempts every category and reports a typed partial-erasure failure", async () => {
		const eraseCompletions = vi.fn(async () => {
			throw new Error("completion storage unavailable");
		});
		const eraseAttempts = vi.fn(async () => 2);
		const eraseRawObservations = vi.fn(async () => 5);
		const privacy = createPrivacyErasure({
			lessonCompletions: { erase: eraseCompletions },
			assessmentAttempts: { erase: eraseAttempts },
			rawEngagementObservations: { erase: eraseRawObservations },
		});

		await expect(
			privacy.eraseMyData({ kind: "verified", learnerId: "core-user-42" }),
		).rejects.toMatchObject({
			name: "PrivacyErasureError",
			code: "LEARN_PRIVACY_ERASURE_FAILED",
			status: 500,
			failedCategories: ["lessonCompletions"],
			deleted: {
				lessonCompletions: 0,
				assessmentAttempts: 2,
				rawEngagementObservations: 5,
			},
		});
		expect([
			eraseCompletions.mock.calls.length,
			eraseAttempts.mock.calls.length,
			eraseRawObservations.mock.calls.length,
		]).toEqual([1, 1, 1]);
	});
});

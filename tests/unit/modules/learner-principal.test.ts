import { describe, expect, it } from "vitest";

import {
	principalFromCore,
	requireVerifiedLearner,
} from "../../../src/modules/learner-principal.js";

describe("learner principal", () => {
	it("maps an authenticated core principal to an opaque verified learner", () => {
		expect(
			principalFromCore({
				id: "core-user-42",
			}),
		).toEqual({
			kind: "verified",
			learnerId: "core-user-42",
		});
	});

	it("represents a missing core principal as anonymous", () => {
		expect(principalFromCore(null)).toEqual({ kind: "anonymous" });
		expect(principalFromCore(undefined)).toEqual({ kind: "anonymous" });
	});

	it("rejects anonymous access before personalized storage is consulted", () => {
		expect(() => requireVerifiedLearner({ kind: "anonymous" })).toThrowError(
			expect.objectContaining({
				name: "LearnerPrincipalError",
				code: "LEARN_UNAUTHENTICATED",
			}),
		);
	});
});

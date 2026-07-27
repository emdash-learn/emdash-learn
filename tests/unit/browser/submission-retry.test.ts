import { describe, expect, it } from "vitest";

import { createSubmissionRetryState } from "../../../src/browser/submission-retry.js";

describe("knowledge-check submission retry state", () => {
	it("reuses an id while the same answer payload has an uncertain outcome", () => {
		let sequence = 0;
		const state = createSubmissionRetryState(() => `submission-${++sequence}`);
		const answers = [{ questionId: "q1", answer: "a1" }];

		expect(state.idFor(answers)).toBe("submission-1");
		expect(state.idFor(structuredClone(answers))).toBe("submission-1");
	});

	it("starts a new submission after an answer change or definitive outcome", () => {
		let sequence = 0;
		const state = createSubmissionRetryState(() => `submission-${++sequence}`);

		expect(state.idFor([{ questionId: "q1", answer: "a1" }])).toBe("submission-1");
		expect(state.idFor([{ questionId: "q1", answer: "a2" }])).toBe("submission-2");

		state.settle();

		expect(state.idFor([{ questionId: "q1", answer: "a2" }])).toBe("submission-3");
	});
});

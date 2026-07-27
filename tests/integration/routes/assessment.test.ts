import { describe, expect, it, vi } from "vitest";

import type { Assessment, DraftCheckInput } from "../../../src/modules/assessment/index.js";
import type { EngagementReporting } from "../../../src/modules/engagement-reporting/index.js";
import { assessmentPresentInput, createAssessmentRoutes } from "../../../src/routes/assessment.js";
import { createRouteContext } from "../../utils/route-context.js";

function unusedAssessment(): Assessment {
	return {
		async createDraft() {
			throw new Error("Unexpected createDraft");
		},
		async getDraft() {
			throw new Error("Unexpected getDraft");
		},
		async listDrafts() {
			throw new Error("Unexpected listDrafts");
		},
		async updateDraft() {
			throw new Error("Unexpected updateDraft");
		},
		async deleteDraft() {
			throw new Error("Unexpected deleteDraft");
		},
		async publish() {
			throw new Error("Unexpected publish");
		},
		async archive() {
			throw new Error("Unexpected archive");
		},
		async present() {
			throw new Error("Unexpected present");
		},
		async selfGrade() {
			throw new Error("Unexpected selfGrade");
		},
		async submitAttempt() {
			throw new Error("Account attempts are not exposed in this release");
		},
		async listAttempts() {
			throw new Error("Account attempts are not exposed in this release");
		},
		async eraseLearnerAttempts() {
			throw new Error("Account attempts are not exposed in this release");
		},
	};
}

function reporting(observe = async () => {}): EngagementReporting {
	return {
		observe,
		async query() {
			return { calculatedThrough: null, courses: [] };
		},
		async pruneExpired() {
			return { observationsPruned: 0 };
		},
	};
}

const authoredDraft: DraftCheckInput = {
	courseId: "course-typescript",
	title: "Safety fundamentals",
	passingScore: 70,
	questions: [
		{
			id: "question-1",
			type: "true_false",
			prompt: "Inspect first?",
			points: 1,
			correctAnswer: true,
		},
	],
};

describe("Assessment routes", () => {
	it("keeps editor authoring routes private and delegates the canonical draft", async () => {
		const createDraft = vi.fn(async (input: DraftCheckInput) => ({
			...input,
			checkId: "check-1",
			createdAt: "2026-07-26T10:00:00.000Z",
			updatedAt: "2026-07-26T10:00:00.000Z",
		}));
		const publish = vi.fn(async () => ({
			courseId: "course-typescript",
			checkId: "check-1",
			revisionId: "revision-1",
			title: authoredDraft.title,
			passingScore: 70,
			questions: [
				{
					id: "question-1",
					type: "true_false" as const,
					prompt: "Inspect first?",
					points: 1,
				},
			],
		}));
		const routes = createAssessmentRoutes({
			createAssessment: () => ({ ...unusedAssessment(), createDraft, publish }),
			createReporting: () => reporting(),
			beforePublicAssessment: async () => {},
			requirePublishedAssessmentCourse: async () => {},
		});

		await routes["assessment:draft-create"].handler(createRouteContext(authoredDraft));
		await routes["assessment:publish"].handler(createRouteContext({ checkId: "check-1" }));

		expect(createDraft).toHaveBeenCalledWith(authoredDraft);
		expect(publish).toHaveBeenCalledWith("check-1");
		expect(routes["assessment:draft-create"].permission).toBe("content:edit_any");
		expect(routes["assessment:publish"].permission).toBe("content:edit_any");
	});

	it("self-grades publicly and reports one best-effort anonymous submission", async () => {
		const selfGrade = vi.fn(async () => ({
			courseId: "course-typescript",
			checkId: "check-1",
			revisionId: "revision-1",
			score: 100,
			passed: true,
			pointsAwarded: 1,
			pointsPossible: 1,
			questions: [
				{
					questionId: "question-1",
					correct: true,
					pointsAwarded: 1,
					pointsPossible: 1,
				},
			],
		}));
		const observe = vi.fn(async () => {
			throw new Error("reporting unavailable");
		});
		const warn = vi.fn();
		const routes = createAssessmentRoutes({
			createAssessment: () => ({ ...unusedAssessment(), selfGrade }),
			createReporting: () => reporting(observe),
			beforePublicAssessment: async () => {},
			requirePublishedAssessmentCourse: async () => {},
		});

		const result = await routes["assessment:self-grade"].handler(
			createRouteContext(
				{
					courseId: "course-typescript",
					checkId: "check-1",
					revisionId: "revision-1",
					answers: [{ questionId: "question-1", answer: true }],
				},
				{ onWarn: warn },
			),
		);

		expect(result).toMatchObject({ score: 100, passed: true });
		expect(observe).toHaveBeenCalledWith({
			type: "check_submitted",
			courseId: "course-typescript",
			checkId: "check-1",
			passed: true,
			score: 100,
		});
		expect(warn).toHaveBeenCalledOnce();
		expect(routes["assessment:self-grade"].public).toBe(true);
	});

	it("exposes only public self-check and editor-authoring routes", () => {
		const routes = createAssessmentRoutes({
			createAssessment: unusedAssessment,
			createReporting: reporting,
			beforePublicAssessment: async () => {},
			requirePublishedAssessmentCourse: async () => {},
		});

		expect(Object.keys(routes)).toEqual([
			"assessment:present",
			"assessment:self-grade",
			"assessment:draft-list",
			"assessment:draft-create",
			"assessment:draft-get",
			"assessment:draft-update",
			"assessment:draft-delete",
			"assessment:publish",
			"assessment:archive",
		]);
		expect(
			assessmentPresentInput.safeParse({
				courseId: "x".repeat(201),
				checkId: "check-1",
			}).success,
		).toBe(false);
	});
});

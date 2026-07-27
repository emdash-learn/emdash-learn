import { describe, expect, it, vi } from "vitest";

import type { Assessment, DraftCheckInput } from "../../../src/modules/assessment/index.js";
import type { EngagementReporting } from "../../../src/modules/engagement-reporting/index.js";
import {
	assessmentPresentInput,
	assessmentSubmitAttemptInput,
	createAssessmentRoutes,
} from "../../../src/routes/assessment.js";
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
			throw new Error("Unexpected submitAttempt");
		},
		async listAttempts() {
			throw new Error("Unexpected listAttempts");
		},
		async eraseLearnerAttempts() {
			throw new Error("Unexpected eraseLearnerAttempts");
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
		const beforePublicAssessment = vi.fn(async () => {});
		const requirePublishedAssessmentCourse = vi.fn(async () => {});
		const warn = vi.fn();
		const routes = createAssessmentRoutes({
			createAssessment: () => ({ ...unusedAssessment(), selfGrade }),
			createReporting: () => reporting(observe),
			beforePublicAssessment,
			requirePublishedAssessmentCourse,
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
		expect(selfGrade).toHaveBeenCalledWith({
			courseId: "course-typescript",
			checkId: "check-1",
			revisionId: "revision-1",
			answers: [{ questionId: "question-1", answer: true }],
		});
		expect(observe).toHaveBeenCalledOnce();
		expect(observe).toHaveBeenCalledWith({
			type: "check_submitted",
			courseId: "course-typescript",
			checkId: "check-1",
			passed: true,
			score: 100,
			actor: { kind: "anonymous" },
		});
		expect(beforePublicAssessment).toHaveBeenCalledOnce();
		expect(requirePublishedAssessmentCourse).toHaveBeenCalledWith(
			expect.anything(),
			"course-typescript",
		);
		expect(warn).toHaveBeenCalledOnce();
		expect(routes["assessment:self-grade"].public).toBe(true);
	});

	it("requires a bounded course id when presenting a public Knowledge Check", () => {
		expect(
			assessmentPresentInput.safeParse({
				courseId: "course-typescript",
				checkId: "check-1",
			}).success,
		).toBe(true);
		expect(
			assessmentPresentInput.safeParse({
				courseId: "x".repeat(201),
				checkId: "check-1",
			}).success,
		).toBe(false);
		expect(assessmentPresentInput.safeParse({ checkId: "check-1" }).success).toBe(false);
	});

	it("derives verified Attempt ownership and never accepts a learner id", async () => {
		const submitAttempt = vi.fn(async () => ({
			courseId: "course-typescript",
			attemptId: "attempt-1",
			submissionId: "submission-1",
			submittedAt: "2026-07-26T12:00:00.000Z",
			checkId: "check-1",
			revisionId: "revision-1",
			score: 80,
			passed: true,
			pointsAwarded: 4,
			pointsPossible: 5,
			questions: [],
			newlyRecorded: true,
		}));
		const listAttempts = vi.fn(async () => []);
		const requirePublishedAssessmentCourse = vi.fn(async () => {});
		const routes = createAssessmentRoutes({
			createAssessment: () => ({
				...unusedAssessment(),
				submitAttempt,
				listAttempts,
			}),
			createReporting: () => reporting(),
			beforePublicAssessment: async () => {},
			requirePublishedAssessmentCourse,
		});
		const principal = { id: "core-user-42" };

		await routes["assessment:submit-attempt"].handler(
			createRouteContext(
				{
					courseId: "course-typescript",
					checkId: "check-1",
					revisionId: "revision-1",
					submissionId: "submission-1",
					answers: [],
				},
				{ principal },
			),
		);
		await routes["assessment:attempts"].handler(
			createRouteContext({ checkId: "check-1" }, { principal }),
		);

		expect(submitAttempt).toHaveBeenCalledWith(
			{ kind: "verified", learnerId: "core-user-42" },
			{
				courseId: "course-typescript",
				checkId: "check-1",
				revisionId: "revision-1",
				submissionId: "submission-1",
				answers: [],
			},
		);
		expect(requirePublishedAssessmentCourse).toHaveBeenCalledWith(
			expect.anything(),
			"course-typescript",
		);
		expect(listAttempts).toHaveBeenCalledWith(
			{ kind: "verified", learnerId: "core-user-42" },
			{ checkId: "check-1" },
		);
		expect(
			assessmentSubmitAttemptInput.safeParse({
				courseId: "course-typescript",
				checkId: "check-1",
				revisionId: "revision-1",
				submissionId: "submission-1",
				answers: [],
				learnerId: "attacker-selected",
			}).success,
		).toBe(false);
		expect(
			assessmentSubmitAttemptInput.safeParse({
				courseId: "course-typescript",
				checkId: "check-1",
				revisionId: "revision-1",
				submissionId: "someone@example.test",
				answers: [],
			}).success,
		).toBe(false);
		expect(
			assessmentSubmitAttemptInput.safeParse({
				courseId: "course-typescript",
				checkId: "check-1",
				revisionId: "revision-1",
				submissionId: "00000000-0000-4000-8000-000000000001",
				answers: [],
			}).success,
		).toBe(true);
		expect(routes["assessment:submit-attempt"].permission).toBe("content:read");
		expect(routes["assessment:attempts"].permission).toBe("content:read");
	});

	it("rejects an anonymous Attempt before constructing personalized services", async () => {
		const createAssessment = vi.fn(() => unusedAssessment());
		const routes = createAssessmentRoutes({
			createAssessment,
			createReporting: () => reporting(),
			beforePublicAssessment: async () => {},
			requirePublishedAssessmentCourse: async () => {},
		});

		await expect(
			routes["assessment:submit-attempt"].handler(
				createRouteContext({
					courseId: "course-typescript",
					checkId: "check-1",
					revisionId: "revision-1",
					submissionId: "submission-1",
					answers: [],
				}),
			),
		).rejects.toMatchObject({ code: "LEARN_UNAUTHENTICATED", status: 401 });
		expect(createAssessment).not.toHaveBeenCalled();
	});

	it("reports only a newly durable verified Attempt and not an idempotent retry", async () => {
		const submitAttempt = vi
			.fn()
			.mockResolvedValueOnce({
				courseId: "course-typescript",
				attemptId: "attempt-1",
				submissionId: "00000000-0000-4000-8000-000000000001",
				submittedAt: "2026-07-26T12:00:00.000Z",
				checkId: "check-1",
				revisionId: "revision-1",
				score: 100,
				passed: true,
				pointsAwarded: 1,
				pointsPossible: 1,
				questions: [],
				newlyRecorded: true,
			})
			.mockResolvedValueOnce({
				courseId: "course-typescript",
				attemptId: "attempt-1",
				submissionId: "00000000-0000-4000-8000-000000000001",
				submittedAt: "2026-07-26T12:00:00.000Z",
				checkId: "check-1",
				revisionId: "revision-1",
				score: 100,
				passed: true,
				pointsAwarded: 1,
				pointsPossible: 1,
				questions: [],
				newlyRecorded: false,
			});
		const observe = vi.fn(async () => {});
		const routes = createAssessmentRoutes({
			createAssessment: () => ({ ...unusedAssessment(), submitAttempt }),
			createReporting: () => reporting(observe),
			beforePublicAssessment: async () => {},
			requirePublishedAssessmentCourse: async () => {},
		});
		const ctx = () =>
			createRouteContext(
				{
					courseId: "course-typescript",
					checkId: "check-1",
					revisionId: "revision-1",
					submissionId: "00000000-0000-4000-8000-000000000001",
					answers: [],
				},
				{ principal: { id: "core-user-42" } },
			);

		await routes["assessment:submit-attempt"].handler(ctx());
		await routes["assessment:submit-attempt"].handler(ctx());

		expect(observe).toHaveBeenCalledOnce();
		expect(observe).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "check_submitted",
				courseId: "course-typescript",
				checkId: "check-1",
			}),
		);
	});
});

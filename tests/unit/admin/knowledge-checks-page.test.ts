import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
	checkEditorHref,
	emptyKnowledgeCheck,
	KnowledgeCheckEditorView,
	parseSelectedCheckId,
	publishAssessmentDraft,
	saveAssessmentDraft,
	validateKnowledgeCheck,
} from "../../../src/admin/KnowledgeChecksPage.js";

describe("knowledge-check editor navigation", () => {
	it("keeps selection in the query string so the registered path stays exact", () => {
		expect(checkEditorHref("kc_abc")).toBe("/_emdash/admin/plugins/lms-core/checks?check=kc_abc");
		expect(checkEditorHref("id with spaces")).toBe(
			"/_emdash/admin/plugins/lms-core/checks?check=id%20with%20spaces",
		);
		expect(parseSelectedCheckId("?check=kc_abc")).toBe("kc_abc");
		expect(parseSelectedCheckId("?quiz=legacy")).toBeNull();
		expect(parseSelectedCheckId("?other=value")).toBeNull();
	});
});

describe("knowledge-check editor validation", () => {
	it("creates a valid canonical single-choice draft without publication status", () => {
		const draft = emptyKnowledgeCheck();
		draft.courseId = "course-1";
		const question = draft.questions[0];

		expect(draft).not.toHaveProperty("status");
		expect(question?.type).toBe("single_choice");
		if (!question || question.type !== "single_choice") {
			throw new Error("Expected the default single-choice question.");
		}
		expect(question).toMatchObject({
			options: [
				{ id: expect.any(String), text: "Answer one" },
				{ id: expect.any(String), text: "Answer two" },
			],
			correctOptionId: expect.any(String),
		});
		expect(question.options[0]).not.toHaveProperty("correct");
		expect(validateKnowledgeCheck(draft)).toEqual([]);
	});

	it("reports author-actionable errors before a route call", () => {
		const draft = emptyKnowledgeCheck();
		draft.courseId = "course-1";
		draft.title = " ";
		draft.passingScore = 101;
		const question = draft.questions[0];
		if (!question || question.type !== "single_choice") {
			throw new Error("Expected the default single-choice question.");
		}
		question.prompt = "";
		question.correctOptionId = "missing-option";

		expect(validateKnowledgeCheck(draft)).toEqual([
			"Add a title.",
			"Passing score must be a whole number from 0 to 100.",
			"Question 1 needs a prompt.",
			"Question 1 must have exactly one correct answer.",
		]);
	});

	it("requires accepted answers for short-text questions", () => {
		const draft = emptyKnowledgeCheck();
		draft.courseId = "course-1";
		draft.questions[0] = {
			id: "q1",
			type: "short_text",
			prompt: "Name the CMS.",
			points: 1,
			acceptedAnswers: [" "],
		};

		expect(validateKnowledgeCheck(draft)).toEqual([
			"Question 1 needs at least one accepted answer.",
		]);
	});
});

describe("knowledge-check draft workflow", () => {
	it("creates a new draft and updates an existing draft through the canonical API", async () => {
		const draft = emptyKnowledgeCheck();
		draft.courseId = "course-1";
		const created = {
			checkId: "check-1",
			...draft,
			createdAt: "2026-07-26T12:00:00.000Z",
			updatedAt: "2026-07-26T12:00:00.000Z",
		};
		const api = {
			createDraft: vi.fn().mockResolvedValue(created),
			updateDraft: vi.fn().mockResolvedValue({
				...created,
				updatedAt: "2026-07-26T12:01:00.000Z",
			}),
		};

		await expect(saveAssessmentDraft(api, null, draft)).resolves.toEqual(created);
		await expect(saveAssessmentDraft(api, "check-1", draft)).resolves.toMatchObject({
			checkId: "check-1",
			updatedAt: "2026-07-26T12:01:00.000Z",
		});

		expect(api.createDraft).toHaveBeenCalledWith(draft);
		expect(api.updateDraft).toHaveBeenCalledWith("check-1", draft);
	});

	it("saves edits before publishing a new immutable revision", async () => {
		const draft = emptyKnowledgeCheck();
		draft.courseId = "course-1";
		const saved = {
			checkId: "check-1",
			...draft,
			createdAt: "2026-07-26T12:00:00.000Z",
			updatedAt: "2026-07-26T12:01:00.000Z",
		};
		const published = {
			courseId: draft.courseId,
			checkId: "check-1",
			revisionId: "revision-2",
			title: draft.title,
			description: draft.description,
			passingScore: draft.passingScore,
			questions: [],
		};
		const api = {
			updateDraft: vi.fn().mockResolvedValue(saved),
			publish: vi.fn().mockResolvedValue(published),
		};

		await expect(publishAssessmentDraft(api, "check-1", draft)).resolves.toEqual({
			draft: saved,
			published,
		});
		expect(api.updateDraft).toHaveBeenCalledWith("check-1", draft);
		expect(api.publish).toHaveBeenCalledWith("check-1");
		expect(api.updateDraft.mock.invocationCallOrder[0]).toBeLessThan(
			api.publish.mock.invocationCallOrder[0],
		);
	});
});

describe("knowledge-check editor presentation", () => {
	it("presents publication as explicit revision actions, not mutable draft status", () => {
		const draft = emptyKnowledgeCheck();
		draft.courseId = "course-1";
		const markup = renderToStaticMarkup(
			createElement(KnowledgeCheckEditorView, {
				checkId: "check-1",
				draft,
				errors: [],
				notice: null,
				busyAction: null,
				onDraftChange: vi.fn(),
				onSave: vi.fn(),
				onPublish: vi.fn(),
				onArchive: vi.fn(),
				onDelete: vi.fn(),
			}),
		);

		expect(markup).toContain("Save draft");
		expect(markup).toContain("Publish revision");
		expect(markup).toContain("Archive published revision");
		expect(markup).toContain("Delete draft");
		expect(markup).toContain("immutable revision");
		expect(markup).toContain(">Course<");
		expect(markup).toContain("course-1 (currently unavailable)");
		expect(markup).not.toContain(">Status<");
	});
});

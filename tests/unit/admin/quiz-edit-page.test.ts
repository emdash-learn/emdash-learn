/**
 * Unit tests for `src/admin/QuizEditPage.tsx` (T21).
 *
 * Covers the pure draft-mutation + validation helpers the page uses. Full
 * component rendering is covered by manual QA against emdash's admin shell
 * (vitest runs in node with no DOM).
 */

import { describe, expect, it } from "vitest";

import {
	addQuestion,
	deleteQuestion,
	draftToCreateInput,
	draftToUpdateInput,
	duplicateQuestion,
	isNewQuizId,
	makeBlankQuestion,
	makeBlankQuiz,
	moveQuestion,
	parseQuizIdFromPath,
	quizToDraft,
	validateDraft,
	type DraftQuestion,
	type DraftQuestionOption,
	type DraftQuiz,
	type MakeId,
} from "../../../src/admin/QuizEditPage.js";
import type { Quiz } from "../../../src/types/storage.js";

function deterministicIdFactory(): MakeId {
	let n = 0;
	return () => `id-${++n}`;
}

describe("parseQuizIdFromPath", () => {
	it("extracts the quizId segment from the canonical admin path", () => {
		expect(parseQuizIdFromPath("/_emdash/admin/plugins/lms-core/quizzes/qz_abc")).toBe("qz_abc");
	});

	it("returns 'new' for the create sentinel", () => {
		expect(parseQuizIdFromPath("/_emdash/admin/plugins/lms-core/quizzes/new")).toBe("new");
	});

	it("decodes percent-encoded ids", () => {
		expect(parseQuizIdFromPath("/_emdash/admin/plugins/lms-core/quizzes/qz%20a")).toBe("qz a");
	});

	it("returns null when the prefix does not match", () => {
		expect(parseQuizIdFromPath("/_emdash/admin/dashboard")).toBeNull();
		expect(parseQuizIdFromPath("/_emdash/admin/plugins/other/quizzes/qz_a")).toBeNull();
		// The list page path has no id segment.
		expect(parseQuizIdFromPath("/_emdash/admin/plugins/lms-core/quizzes")).toBeNull();
	});

	it("returns null when the id segment is empty or malformed", () => {
		expect(parseQuizIdFromPath("/_emdash/admin/plugins/lms-core/quizzes/")).toBeNull();
		expect(parseQuizIdFromPath("/_emdash/admin/plugins/lms-core/quizzes/%ZZ")).toBeNull();
	});
});

describe("isNewQuizId", () => {
	it("matches the sentinel exactly", () => {
		expect(isNewQuizId("new")).toBe(true);
		expect(isNewQuizId("New")).toBe(false);
		expect(isNewQuizId("qz_new")).toBe(false);
	});
});

describe("makeBlankQuiz", () => {
	it("seeds a single MCQ question with two empty options", () => {
		const draft = makeBlankQuiz(deterministicIdFactory());
		expect(draft.title).toBe("");
		expect(draft.passingScore).toBe(70);
		expect(draft.timeLimitPolicy).toBe("hard");
		expect(draft.randomize).toBe(false);
		expect(draft.questions).toHaveLength(1);
		const [q] = draft.questions;
		expect(q?.type).toBe("mcq");
		expect(q?.options).toHaveLength(2);
		expect(q?.options?.some((o) => o.correct)).toBe(false);
	});

	it("omits timeLimit from a fresh draft", () => {
		const draft = makeBlankQuiz(deterministicIdFactory());
		expect(draft.timeLimit).toBeUndefined();
	});
});

describe("makeBlankQuestion", () => {
	it("renders 'True' / 'False' options for true_false", () => {
		const q = makeBlankQuestion("true_false", deterministicIdFactory());
		expect(q.options?.map((o) => o.text)).toEqual(["True", "False"]);
		expect(q.options?.some((o) => o.correct)).toBe(false);
	});

	it("does not include options for short_text", () => {
		const q = makeBlankQuestion("short_text", deterministicIdFactory());
		expect(q.options).toBeUndefined();
	});
});

describe("quizToDraft", () => {
	it("round-trips a stored Quiz into an editable draft without losing fields", () => {
		const quiz: Quiz = {
			title: "SQL Joins",
			description: "Covers inner + outer joins",
			passingScore: 80,
			timeLimit: 15,
			timeLimitPolicy: "soft",
			randomize: true,
			questions: [
				{
					id: "q1",
					type: "mcq",
					prompt: "What is an INNER JOIN?",
					options: [
						{ id: "o1", text: "All rows from both", correct: false },
						{ id: "o2", text: "Matching rows only", correct: true },
					],
					explanation: "Returns only matches.",
					points: 2,
				},
			],
			createdAt: "2026-04-01T00:00:00Z",
			updatedAt: "2026-04-18T00:00:00Z",
		};
		const draft = quizToDraft(quiz);
		expect(draft.title).toBe("SQL Joins");
		expect(draft.description).toBe("Covers inner + outer joins");
		expect(draft.timeLimit).toBe(15);
		expect(draft.timeLimitPolicy).toBe("soft");
		expect(draft.randomize).toBe(true);
		expect(draft.questions).toHaveLength(1);
		expect(draft.questions[0]?.points).toBe(2);
		expect(draft.questions[0]?.options?.[1]?.correct).toBe(true);
	});

	it("defaults a missing description to an empty string", () => {
		const quiz: Quiz = {
			title: "T",
			passingScore: 70,
			timeLimitPolicy: "hard",
			randomize: false,
			questions: [{ id: "q1", type: "short_text", prompt: "Who?", points: 1 }],
			createdAt: "2026-04-01T00:00:00Z",
			updatedAt: "2026-04-01T00:00:00Z",
		};
		expect(quizToDraft(quiz).description).toBe("");
	});
});

describe("addQuestion", () => {
	it("appends a new question at the end", () => {
		const makeId = deterministicIdFactory();
		const before = [makeBlankQuestion("mcq", makeId)];
		const after = addQuestion(before, "short_text", makeId);
		expect(after).toHaveLength(2);
		expect(after[0]).toBe(before[0]); // original preserved
		expect(after[1]?.type).toBe("short_text");
	});
});

describe("duplicateQuestion", () => {
	it("inserts a copy directly after the source with a fresh id", () => {
		const makeId = deterministicIdFactory();
		const source: DraftQuestion = {
			id: "original",
			type: "mcq",
			prompt: "Pick one",
			options: [
				{ id: "o-a", text: "A", correct: true },
				{ id: "o-b", text: "B", correct: false },
			],
			points: 1,
		};
		const after = duplicateQuestion([source], 0, makeId);
		expect(after).toHaveLength(2);
		expect(after[1]?.id).not.toBe("original");
		expect(after[1]?.options?.[0]?.id).not.toBe("o-a");
		expect(after[1]?.prompt).toBe("Pick one");
	});

	it("is a no-op for an out-of-range index", () => {
		const q: DraftQuestion = {
			id: "x",
			type: "short_text",
			prompt: "?",
			points: 1,
		};
		expect(duplicateQuestion([q], 5)).toEqual([q]);
	});
});

describe("deleteQuestion", () => {
	it("removes the question at the given index", () => {
		const base: DraftQuestion[] = [
			{ id: "a", type: "short_text", prompt: "a", points: 1 },
			{ id: "b", type: "short_text", prompt: "b", points: 1 },
			{ id: "c", type: "short_text", prompt: "c", points: 1 },
		];
		expect(deleteQuestion(base, 1).map((q) => q.id)).toEqual(["a", "c"]);
	});

	it("is a no-op for an out-of-range index", () => {
		const base: DraftQuestion[] = [{ id: "a", type: "short_text", prompt: "a", points: 1 }];
		expect(deleteQuestion(base, 7)).toEqual(base);
	});
});

describe("moveQuestion", () => {
	const base: DraftQuestion[] = [
		{ id: "a", type: "short_text", prompt: "a", points: 1 },
		{ id: "b", type: "short_text", prompt: "b", points: 1 },
		{ id: "c", type: "short_text", prompt: "c", points: 1 },
	];

	it("swaps with the previous item when moving up", () => {
		expect(moveQuestion(base, 1, "up").map((q) => q.id)).toEqual(["b", "a", "c"]);
	});

	it("swaps with the next item when moving down", () => {
		expect(moveQuestion(base, 1, "down").map((q) => q.id)).toEqual(["a", "c", "b"]);
	});

	it("is a no-op at the boundaries", () => {
		expect(moveQuestion(base, 0, "up")).toBe(base);
		expect(moveQuestion(base, base.length - 1, "down")).toBe(base);
	});
});

function blankOkDraft(): DraftQuiz {
	return {
		title: "Sample",
		description: "",
		passingScore: 70,
		timeLimitPolicy: "hard",
		randomize: false,
		questions: [
			{
				id: "q1",
				type: "mcq",
				prompt: "Prompt",
				options: [
					{ id: "a", text: "A", correct: true },
					{ id: "b", text: "B", correct: false },
				],
				points: 1,
			},
		],
	};
}

function firstQuestion(draft: DraftQuiz): DraftQuestion {
	const q = draft.questions[0];
	if (!q) throw new Error("test draft has no questions");
	return q;
}

function optionAt(q: DraftQuestion, index: number): DraftQuestionOption {
	const o = q.options?.[index];
	if (!o) throw new Error(`test question has no option at index ${index}`);
	return o;
}

describe("validateDraft", () => {
	it("passes a clean draft", () => {
		const result = validateDraft(blankOkDraft());
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});

	it("flags a missing title", () => {
		const draft = blankOkDraft();
		draft.title = "   ";
		expect(validateDraft(draft).errors).toContain("Title is required.");
	});

	it("flags a passing score outside 0–100", () => {
		const draft = blankOkDraft();
		draft.passingScore = 101;
		expect(validateDraft(draft).errors).toEqual(
			expect.arrayContaining(["Passing score must be between 0 and 100."]),
		);
	});

	it("flags an MCQ with zero or multiple correct options", () => {
		const draft = blankOkDraft();
		const q = firstQuestion(draft);
		// zero correct
		optionAt(q, 0).correct = false;
		optionAt(q, 1).correct = false;
		expect(validateDraft(draft).errors).toEqual(
			expect.arrayContaining(["Question 1: pick exactly 1 correct option."]),
		);
		// multiple correct
		optionAt(q, 0).correct = true;
		optionAt(q, 1).correct = true;
		expect(validateDraft(draft).errors).toEqual(
			expect.arrayContaining(["Question 1: pick exactly 1 correct option."]),
		);
	});

	it("flags a multi-select with no correct options", () => {
		const draft = blankOkDraft();
		const q = firstQuestion(draft);
		q.type = "multi";
		optionAt(q, 0).correct = false;
		optionAt(q, 1).correct = false;
		expect(validateDraft(draft).errors).toEqual(
			expect.arrayContaining(["Question 1: mark at least 1 correct option."]),
		);
	});

	it("flags a non-integer time limit", () => {
		const draft = blankOkDraft();
		draft.timeLimit = 1.5;
		expect(validateDraft(draft).errors).toEqual(
			expect.arrayContaining(["Time limit must be a positive whole number of minutes."]),
		);
	});

	it("flags a true_false with no answer picked", () => {
		const draft = blankOkDraft();
		draft.questions = [
			{
				id: "q1",
				type: "true_false",
				prompt: "?",
				options: [
					{ id: "t", text: "True", correct: false },
					{ id: "f", text: "False", correct: false },
				],
				points: 1,
			},
		];
		expect(validateDraft(draft).errors).toEqual(
			expect.arrayContaining(["Question 1: select True or False as the answer."]),
		);
	});
});

describe("draftToCreateInput", () => {
	it("trims strings and drops empty optional fields", () => {
		const draft: DraftQuiz = {
			title: "  Hello  ",
			description: "   ",
			passingScore: 70,
			timeLimitPolicy: "hard",
			randomize: false,
			questions: [
				{
					id: "q1",
					type: "short_text",
					prompt: "  Who?  ",
					explanation: "   ",
					points: 1,
				},
			],
		};
		const input = draftToCreateInput(draft);
		expect(input.title).toBe("Hello");
		expect(input.description).toBeUndefined();
		expect(input.timeLimit).toBeUndefined();
		expect(input.questions[0]?.prompt).toBe("Who?");
		expect(input.questions[0]?.explanation).toBeUndefined();
	});

	it("keeps a non-empty description and time limit", () => {
		const draft: DraftQuiz = {
			title: "Sample",
			description: "A description",
			passingScore: 80,
			timeLimit: 10,
			timeLimitPolicy: "soft",
			randomize: true,
			questions: [{ id: "q1", type: "short_text", prompt: "?", points: 1 }],
		};
		const input = draftToCreateInput(draft);
		expect(input.description).toBe("A description");
		expect(input.timeLimit).toBe(10);
		expect(input.timeLimitPolicy).toBe("soft");
		expect(input.randomize).toBe(true);
	});
});

describe("draftToUpdateInput", () => {
	it("carries the quizId onto the create payload", () => {
		const draft: DraftQuiz = {
			title: "T",
			description: "",
			passingScore: 70,
			timeLimitPolicy: "hard",
			randomize: false,
			questions: [{ id: "q1", type: "short_text", prompt: "?", points: 1 }],
		};
		const input = draftToUpdateInput(draft, "qz_xyz");
		expect(input.quizId).toBe("qz_xyz");
		expect(input.title).toBe("T");
	});
});

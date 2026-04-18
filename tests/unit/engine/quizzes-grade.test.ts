/**
 * Pure-function unit tests for `engine.quizzes.grade()` (T08, §21 Phase 3).
 *
 * `grade()` is the single source of truth for "did the student pass?" — every
 * other code path that scores an attempt (route, reconciler auto-submit,
 * preview) calls into it. The matrix below exercises:
 *
 *   - All four question types (mcq, multi, true_false, short_text), each
 *     with happy + unhappy variants.
 *   - Both time-limit policies (`hard` / `soft`) and both timing outcomes
 *     (within / past the limit).
 *   - Edge cases that have bitten earlier LMS implementations: zero-point
 *     questions, options with no correct flag, missing answers, mixed
 *     case in short-text, multi-select with extra/missing selections,
 *     true/false submitted as a literal boolean string vs. an option id.
 *
 * The function is pure — no `ctx`, no I/O — so every test is a one-liner
 * arrange/assert with no fixtures or fake timers.
 */

import { describe, expect, test } from "vitest";

import { grade } from "../../../src/engine/quizzes.js";
import type { Quiz, QuizAttempt, QuizQuestion } from "../../../src/types/storage.js";

// ---------------------------------------------------------------------------
// Fixture builders — keep tests terse + intent-revealing.
// ---------------------------------------------------------------------------

function quiz(overrides: Partial<Quiz>, questions: QuizQuestion[]): Quiz {
	return {
		title: "Test Quiz",
		passingScore: 70,
		timeLimitPolicy: "hard",
		randomize: false,
		questions,
		createdAt: "2026-04-01T00:00:00.000Z",
		updatedAt: "2026-04-01T00:00:00.000Z",
		...overrides,
	};
}

function attempt(
	overrides: Partial<QuizAttempt>,
	answers: QuizAttempt["answers"] = [],
): QuizAttempt {
	return {
		userId: "user_test",
		quizId: "quiz_test",
		startedAt: "2026-04-17T12:00:00.000Z",
		answers,
		...overrides,
	};
}

const NOW = new Date("2026-04-17T12:05:00.000Z");

// ---------------------------------------------------------------------------
// Scoring math + Result envelope
// ---------------------------------------------------------------------------

describe("grade() — scoring math", () => {
	test("score is rounded to nearest integer percent of points awarded", () => {
		const q: QuizQuestion[] = [
			{
				id: "q1",
				type: "mcq",
				prompt: "1?",
				points: 1,
				options: [
					{ id: "a", text: "yes", correct: true },
					{ id: "b", text: "no", correct: false },
				],
			},
			{
				id: "q2",
				type: "mcq",
				prompt: "2?",
				points: 2,
				options: [
					{ id: "a", text: "yes", correct: true },
					{ id: "b", text: "no", correct: false },
				],
			},
			{
				id: "q3",
				type: "mcq",
				prompt: "3?",
				points: 1,
				options: [
					{ id: "a", text: "yes", correct: true },
					{ id: "b", text: "no", correct: false },
				],
			},
		];
		// 3 of 4 points = 75%
		const result = grade(
			attempt({}, [
				{ questionId: "q1", answer: "a" },
				{ questionId: "q2", answer: "a" },
				{ questionId: "q3", answer: "b" },
			]),
			quiz({ passingScore: 70 }, q),
			NOW,
		);
		expect(result.score).toBe(75);
		expect(result.passed).toBe(true);
	});

	test("zero-point questions: score collapses to 0 and only `passingScore<=0` counts as a pass", () => {
		const q: QuizQuestion[] = [
			{
				id: "q1",
				type: "mcq",
				prompt: "1?",
				points: 0,
				options: [{ id: "a", text: "x", correct: true }],
			},
		];
		const failing = grade(
			attempt({}, [{ questionId: "q1", answer: "a" }]),
			quiz({ passingScore: 70 }, q),
			NOW,
		);
		expect(failing.score).toBe(0);
		expect(failing.passed).toBe(false);

		const passing = grade(
			attempt({}, [{ questionId: "q1", answer: "a" }]),
			quiz({ passingScore: 0 }, q),
			NOW,
		);
		expect(passing.score).toBe(0);
		expect(passing.passed).toBe(true);
	});

	test("unanswered questions count as wrong with 0 points awarded", () => {
		const q: QuizQuestion[] = [
			{
				id: "q1",
				type: "mcq",
				prompt: "1?",
				points: 1,
				options: [
					{ id: "a", text: "x", correct: true },
					{ id: "b", text: "y", correct: false },
				],
			},
			{
				id: "q2",
				type: "mcq",
				prompt: "2?",
				points: 1,
				options: [
					{ id: "a", text: "x", correct: true },
					{ id: "b", text: "y", correct: false },
				],
			},
		];
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: "a" }]),
			quiz({ passingScore: 70 }, q),
			NOW,
		);
		const q2feedback = result.feedback.find((f) => f.questionId === "q2");
		expect(q2feedback).toMatchObject({ correct: false, pointsAwarded: 0, pointsPossible: 1 });
		expect(result.score).toBe(50);
		expect(result.passed).toBe(false);
	});

	test("feedback array carries one entry per question with explanation passthrough", () => {
		const q: QuizQuestion[] = [
			{
				id: "q1",
				type: "mcq",
				prompt: "1?",
				points: 1,
				explanation: "Because.",
				options: [
					{ id: "a", text: "yes", correct: true },
					{ id: "b", text: "no", correct: false },
				],
			},
		];
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: "a" }]),
			quiz({ passingScore: 70 }, q),
			NOW,
		);
		expect(result.feedback).toHaveLength(1);
		expect(result.feedback[0]?.explanation).toBe("Because.");
	});
});

// ---------------------------------------------------------------------------
// MCQ — single correct option
// ---------------------------------------------------------------------------

describe("grade() — MCQ", () => {
	const mcqQuestion: QuizQuestion = {
		id: "q1",
		type: "mcq",
		prompt: "Which is a primary color?",
		points: 1,
		options: [
			{ id: "red", text: "Red", correct: true },
			{ id: "green", text: "Green", correct: false },
			{ id: "purple", text: "Purple", correct: false },
		],
	};

	test("correct answer is graded as 100%", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: "red" }]),
			quiz({}, [mcqQuestion]),
			NOW,
		);
		expect(result.score).toBe(100);
		expect(result.passed).toBe(true);
		expect(result.feedback[0]?.correct).toBe(true);
	});

	test("wrong answer is graded as 0%", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: "purple" }]),
			quiz({}, [mcqQuestion]),
			NOW,
		);
		expect(result.score).toBe(0);
		expect(result.passed).toBe(false);
		expect(result.feedback[0]?.correct).toBe(false);
	});

	test("submitting an array of multiple options is rejected (MCQ accepts exactly one)", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: ["red", "green"] }]),
			quiz({}, [mcqQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Multi-select — set equality required
// ---------------------------------------------------------------------------

describe("grade() — multi-select", () => {
	const multiQuestion: QuizQuestion = {
		id: "q1",
		type: "multi",
		prompt: "Pick the primary colors",
		points: 2,
		options: [
			{ id: "red", text: "Red", correct: true },
			{ id: "blue", text: "Blue", correct: true },
			{ id: "yellow", text: "Yellow", correct: true },
			{ id: "green", text: "Green", correct: false },
			{ id: "purple", text: "Purple", correct: false },
		],
	};

	test("exactly the correct set selected → full credit", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: ["red", "blue", "yellow"] }]),
			quiz({}, [multiQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(true);
		expect(result.feedback[0]?.pointsAwarded).toBe(2);
	});

	test("missing one correct option → marked wrong (no partial credit)", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: ["red", "blue"] }]),
			quiz({}, [multiQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(false);
		expect(result.feedback[0]?.pointsAwarded).toBe(0);
	});

	test("includes an extra wrong option → marked wrong", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: ["red", "blue", "yellow", "green"] }]),
			quiz({}, [multiQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(false);
	});

	test("answer order does not matter (set comparison)", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: ["yellow", "red", "blue"] }]),
			quiz({}, [multiQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// True/false — accepts option id OR literal "true"/"false"
// ---------------------------------------------------------------------------

describe("grade() — true/false", () => {
	const tfQuestion: QuizQuestion = {
		id: "q1",
		type: "true_false",
		prompt: "The sky is blue.",
		points: 1,
		options: [
			{ id: "t", text: "True", correct: true },
			{ id: "f", text: "False", correct: false },
		],
	};

	test("submitting the option id of the correct answer → graded correct", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: "t" }]),
			quiz({}, [tfQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(true);
	});

	test("submitting literal boolean `true` (coerced to string) → graded correct", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: true }]),
			quiz({}, [tfQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(true);
	});

	test("submitting literal boolean `false` against True → graded wrong", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: false }]),
			quiz({}, [tfQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(false);
	});

	test("submitting the wrong option id → graded wrong", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: "f" }]),
			quiz({}, [tfQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Short-text — case-insensitive, trimmed, synonyms allowed
// ---------------------------------------------------------------------------

describe("grade() — short-text", () => {
	const stQuestion: QuizQuestion = {
		id: "q1",
		type: "short_text",
		prompt: "Capital of France?",
		points: 1,
		options: [
			{ id: "a", text: "Paris", correct: true },
			{ id: "b", text: "paris, france", correct: true }, // synonym
		],
	};

	test("exact-case match → graded correct", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: "Paris" }]),
			quiz({}, [stQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(true);
	});

	test("different case → graded correct (case-insensitive per §21 Phase 3)", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: "PARIS" }]),
			quiz({}, [stQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(true);
	});

	test("leading/trailing whitespace is trimmed before comparison", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: "  paris  " }]),
			quiz({}, [stQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(true);
	});

	test("synonym option matches", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: "Paris, France" }]),
			quiz({}, [stQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(true);
	});

	test("wrong answer → graded wrong", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: "London" }]),
			quiz({}, [stQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(false);
	});

	test("blank/whitespace-only answer → graded wrong", () => {
		const result = grade(
			attempt({}, [{ questionId: "q1", answer: "   " }]),
			quiz({}, [stQuestion]),
			NOW,
		);
		expect(result.feedback[0]?.correct).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Time-limit policy: HARD vs. SOFT × within / past limit
// ---------------------------------------------------------------------------

describe("grade() — time-limit policy: HARD", () => {
	const baseQuestion: QuizQuestion = {
		id: "q1",
		type: "mcq",
		prompt: "?",
		points: 1,
		options: [{ id: "a", text: "a", correct: true }],
	};

	test("submitted within the hard limit → overtime=false, normal grading", () => {
		// timeLimit 600s = 10 min; submit @ +5min from start → within limit
		const startedAt = "2026-04-17T12:00:00.000Z";
		const submittedAt = "2026-04-17T12:05:00.000Z";
		const result = grade(
			attempt({ startedAt, submittedAt }, [{ questionId: "q1", answer: "a" }]),
			quiz({ timeLimit: 600, timeLimitPolicy: "hard" }, [baseQuestion]),
			new Date(submittedAt),
		);
		expect(result.overtime).toBe(false);
		expect(result.passed).toBe(true);
	});

	test("submitted past the hard limit → overtime=true (engine route still rejects with LEARN_QUIZ_TIMEOUT, grade() itself does not enforce policy)", () => {
		const startedAt = "2026-04-17T12:00:00.000Z";
		const submittedAt = "2026-04-17T12:15:00.000Z";
		const result = grade(
			attempt({ startedAt, submittedAt }, [{ questionId: "q1", answer: "a" }]),
			quiz({ timeLimit: 600, timeLimitPolicy: "hard" }, [baseQuestion]),
			new Date(submittedAt),
		);
		// `grade()` is policy-agnostic: it reports the timing fact via `overtime`
		// and leaves the route to refuse the submit. This guards against a future
		// refactor that routes the auto-submit reconciler through `grade()` —
		// the field is here for it to read.
		expect(result.overtime).toBe(true);
		expect(result.passed).toBe(true); // score is still computed
	});

	test("untimed quiz (no timeLimit) → overtime=false regardless of how late the submit", () => {
		const startedAt = "2026-04-17T12:00:00.000Z";
		const submittedAt = "2026-04-17T18:00:00.000Z"; // 6 hours later
		const result = grade(
			attempt({ startedAt, submittedAt }, [{ questionId: "q1", answer: "a" }]),
			quiz({ timeLimit: undefined, timeLimitPolicy: "hard" }, [baseQuestion]),
			new Date(submittedAt),
		);
		expect(result.overtime).toBe(false);
	});
});

describe("grade() — time-limit policy: SOFT", () => {
	const baseQuestion: QuizQuestion = {
		id: "q1",
		type: "mcq",
		prompt: "?",
		points: 1,
		options: [{ id: "a", text: "a", correct: true }],
	};

	test("submitted within the soft limit → overtime=false", () => {
		const startedAt = "2026-04-17T12:00:00.000Z";
		const submittedAt = "2026-04-17T12:09:59.000Z";
		const result = grade(
			attempt({ startedAt, submittedAt }, [{ questionId: "q1", answer: "a" }]),
			quiz({ timeLimit: 600, timeLimitPolicy: "soft" }, [baseQuestion]),
			new Date(submittedAt),
		);
		expect(result.overtime).toBe(false);
	});

	test("submitted past the soft limit → overtime=true and the grade still counts (instructor reviews per §8.5)", () => {
		const startedAt = "2026-04-17T12:00:00.000Z";
		const submittedAt = "2026-04-17T12:11:00.000Z";
		const result = grade(
			attempt({ startedAt, submittedAt }, [{ questionId: "q1", answer: "a" }]),
			quiz({ timeLimit: 600, timeLimitPolicy: "soft" }, [baseQuestion]),
			new Date(submittedAt),
		);
		expect(result.overtime).toBe(true);
		expect(result.passed).toBe(true);
		expect(result.score).toBe(100);
	});

	test("attempt with no submittedAt yet falls back to `now` for overtime detection", () => {
		const startedAt = "2026-04-17T12:00:00.000Z";
		const now = new Date("2026-04-17T12:11:00.000Z");
		const result = grade(
			attempt(
				{ startedAt }, // no submittedAt — preview-style call
				[{ questionId: "q1", answer: "a" }],
			),
			quiz({ timeLimit: 600, timeLimitPolicy: "soft" }, [baseQuestion]),
			now,
		);
		expect(result.overtime).toBe(true);
	});

	test("exactly on the boundary is treated as on-time (overtime=false)", () => {
		const startedAt = "2026-04-17T12:00:00.000Z";
		const submittedAt = "2026-04-17T12:10:00.000Z"; // exactly +600s
		const result = grade(
			attempt({ startedAt, submittedAt }, [{ questionId: "q1", answer: "a" }]),
			quiz({ timeLimit: 600, timeLimitPolicy: "soft" }, [baseQuestion]),
			new Date(submittedAt),
		);
		expect(result.overtime).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Cross-type quiz: a single attempt mixing every supported question type
// ---------------------------------------------------------------------------

describe("grade() — mixed-type quiz", () => {
	test("scores a quiz containing one of each question type", () => {
		const q: QuizQuestion[] = [
			{
				id: "mcq",
				type: "mcq",
				prompt: "MCQ",
				points: 1,
				options: [
					{ id: "a", text: "a", correct: true },
					{ id: "b", text: "b", correct: false },
				],
			},
			{
				id: "multi",
				type: "multi",
				prompt: "Multi",
				points: 2,
				options: [
					{ id: "x", text: "x", correct: true },
					{ id: "y", text: "y", correct: true },
					{ id: "z", text: "z", correct: false },
				],
			},
			{
				id: "tf",
				type: "true_false",
				prompt: "True?",
				points: 1,
				options: [
					{ id: "t", text: "True", correct: true },
					{ id: "f", text: "False", correct: false },
				],
			},
			{
				id: "st",
				type: "short_text",
				prompt: "Capital?",
				points: 1,
				options: [{ id: "p", text: "Paris", correct: true }],
			},
		];

		const result = grade(
			attempt({}, [
				{ questionId: "mcq", answer: "a" },
				{ questionId: "multi", answer: ["x", "y"] },
				{ questionId: "tf", answer: true },
				{ questionId: "st", answer: "paris" },
			]),
			quiz({ passingScore: 80 }, q),
			NOW,
		);
		expect(result.score).toBe(100);
		expect(result.passed).toBe(true);
		expect(result.feedback.every((f) => f.correct)).toBe(true);
	});
});

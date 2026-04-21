/**
 * Integration tests for `engine/quizzes.ts` (T08).
 *
 * Covers CRUD, startAttempt/submitAttempt lifecycle, the hard time-limit
 * rejection, and the terminal-quiz-passed → lesson:completed rule.
 *
 * Note: the event bus has been removed (AUDIT C1, Track C). The
 * terminal-quiz-passed test now reads the step_progress row directly from
 * storage rather than asserting a lesson:completed event.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { PluginContext } from "emdash";

import * as quizzes from "../../../src/engine/quizzes.js";
import {
	publishContent,
	seedCourse,
	seedEnrollment,
	seedLesson,
	seedQuiz,
	seedStudent,
} from "../../utils/seed.js";
import { createTestPluginCtx } from "../../utils/test-plugin-ctx.js";

type TestCtx = Awaited<ReturnType<typeof createTestPluginCtx>>;

const contexts: TestCtx[] = [];

async function newCtx(): Promise<TestCtx> {
	const ctx = await createTestPluginCtx();
	contexts.push(ctx);
	return ctx;
}

afterEach(async () => {
	const pending = contexts.splice(0, contexts.length);
	await Promise.all(pending.map((ctx) => ctx.teardown()));
});

const mcqCorrect = {
	id: "q1",
	type: "mcq" as const,
	prompt: "Primary color?",
	points: 1,
	options: [
		{ id: "red", text: "Red", correct: true },
		{ id: "green", text: "Green", correct: false },
	],
};

describe("engine/quizzes.create / update / list / remove", () => {
	it("creates a quiz and stores it", async () => {
		const { ctx } = await newCtx();
		const created = await quizzes.create(ctx, {
			title: "Test",
			passingScore: 70,
			questions: [mcqCorrect],
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(created.data.data.title).toBe("Test");
	});

	it("update merges the patch and bumps updatedAt", async () => {
		const { ctx } = await newCtx();
		const created = await quizzes.create(ctx, {
			title: "A",
			passingScore: 70,
			questions: [mcqCorrect],
		});
		if (!created.ok) throw new Error("setup failed");

		const patched = await quizzes.update(ctx, created.data.id, { title: "B" });
		expect(patched.ok).toBe(true);
		if (!patched.ok) return;
		expect(patched.data.data.title).toBe("B");
		expect(patched.data.data.passingScore).toBe(70);
	});

	it("list returns the quiz", async () => {
		const { ctx } = await newCtx();
		await quizzes.create(ctx, {
			title: "A",
			passingScore: 70,
			questions: [mcqCorrect],
		});
		const page = await quizzes.list(ctx);
		expect(page.ok && page.data.items.length).toBe(1);
	});

	it("remove is idempotent on missing quiz", async () => {
		const { ctx } = await newCtx();
		const gone = await quizzes.remove(ctx, "quiz_missing");
		expect(gone.ok).toBe(true);
	});
});

// Helper: seed the full context needed for startAttempt (quiz + lesson attachment + enrollment).
async function seedQuizCtx(
	ctx: PluginContext,
	questions: typeof mcqCorrect[],
	email: string,
) {
	const quizRecord = await seedQuiz(ctx, { questions });
	const student = await seedStudent(ctx, { email });
	const course = await seedCourse(ctx, { title: "Quiz Course" });
	const lesson = await seedLesson(ctx, { courseId: course.id, quizId: quizRecord.id });
	await seedEnrollment(ctx, { userId: student.id, courseId: course.id });
	return { quizRecord, student, course, lesson };
}

describe("engine/quizzes.startAttempt + submitAttempt", () => {
	it("starts an attempt and returns sanitized questions (no `correct` flag)", async () => {
		const { ctx } = await newCtx();
		const { quizRecord, student, lesson } = await seedQuizCtx(ctx, [mcqCorrect], "s1@x.com");
		const started = await quizzes.startAttempt(ctx, student.id, quizRecord.id, lesson.id);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const opts = started.data.questions[0]?.options ?? [];
		expect(opts.every((o) => !("correct" in o))).toBe(true);
	});

	it("submits an attempt, grades it, and persists score + passed", async () => {
		const { ctx } = await newCtx();
		const { quizRecord, student, lesson } = await seedQuizCtx(ctx, [mcqCorrect], "s2@x.com");
		const started = await quizzes.startAttempt(ctx, student.id, quizRecord.id, lesson.id);
		if (!started.ok) throw new Error("setup failed");

		const submitted = await quizzes.submitAttempt(ctx, started.data.attemptId, [
			{ questionId: "q1", answer: "red" },
		]);

		expect(submitted.ok).toBe(true);
		if (!submitted.ok) return;
		expect(submitted.data.score).toBe(100);
		expect(submitted.data.passed).toBe(true);
	});

	it("rejects a duplicate submit with LEARN_QUIZ_NOT_STARTED", async () => {
		const { ctx } = await newCtx();
		const { quizRecord, student, lesson } = await seedQuizCtx(ctx, [mcqCorrect], "s3@x.com");
		const started = await quizzes.startAttempt(ctx, student.id, quizRecord.id, lesson.id);
		if (!started.ok) throw new Error("setup failed");
		await quizzes.submitAttempt(ctx, started.data.attemptId, [{ questionId: "q1", answer: "red" }]);
		const again = await quizzes.submitAttempt(ctx, started.data.attemptId, [
			{ questionId: "q1", answer: "red" },
		]);
		expect(again.ok).toBe(false);
		if (again.ok) return;
		expect(again.error.code).toBe("LEARN_QUIZ_NOT_STARTED");
	});

	it("hard-timeout policy: submit past the limit returns LEARN_QUIZ_TIMEOUT and persists passed=false", async () => {
		const { ctx } = await newCtx();
		const quizRecord = await seedQuiz(ctx, {
			timeLimit: 1, // 1 second
			timeLimitPolicy: "hard",
			questions: [mcqCorrect],
		});
		const student = await seedStudent(ctx, { email: "s4@x.com" });
		const course = await seedCourse(ctx, { title: "Timeout Course" });
		const lesson = await seedLesson(ctx, { courseId: course.id, quizId: quizRecord.id });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const started = await quizzes.startAttempt(ctx, student.id, quizRecord.id, lesson.id);
		if (!started.ok) throw new Error("setup failed");

		// Backdate the attempt by rewriting startedAt well beyond the limit.
		const attempts = ctx.storage["quiz_attempts"];
		if (!attempts) throw new Error("quiz_attempts missing");
		const row = (await attempts.get(started.data.attemptId)) as {
			startedAt: string;
			[k: string]: unknown;
		} | null;
		if (!row) throw new Error("attempt row missing");
		await attempts.put(started.data.attemptId, {
			...row,
			startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
		});

		const submitted = await quizzes.submitAttempt(ctx, started.data.attemptId, [
			{ questionId: "q1", answer: "red" },
		]);
		expect(submitted.ok).toBe(false);
		if (submitted.ok) return;
		expect(submitted.error.code).toBe("LEARN_QUIZ_TIMEOUT");

		const after = (await attempts.get(started.data.attemptId)) as {
			passed?: boolean;
			overtime?: boolean;
		};
		expect(after.passed).toBe(false);
		expect(after.overtime).toBe(true);
	});

	it("terminal-quiz-passed marks lesson complete in storage when attempt is bound to a lesson", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "tq@test.local" });
		const course = await seedCourse(ctx, { title: "TQ" });
		await publishContent(ctx, "courses", course.id);
		// Quiz must be created before the lesson so its id can be attached.
		const quiz = await seedQuiz(ctx, { questions: [mcqCorrect] });
		const lesson = await seedLesson(ctx, { courseId: course.id, order: 0, quizId: quiz.id });
		await publishContent(ctx, "lessons", lesson.id);
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const started = await quizzes.startAttempt(ctx, student.id, quiz.id, lesson.id);
		if (!started.ok) throw new Error("setup failed");
		const submitted = await quizzes.submitAttempt(ctx, started.data.attemptId, [
			{ questionId: "q1", answer: "red" },
		]);

		expect(submitted.ok && submitted.data.passed).toBe(true);

		// Verify lesson was marked complete in storage (authoritative fact).
		// Post-ADR 0001: step_progress rows use deterministic id prog__userId__lesson__lessonId.
		const stepProg = (
			ctx.storage as unknown as {
				step_progress: { get: (id: string) => Promise<unknown> };
			}
		).step_progress;
		const lessonRow = (await stepProg.get(
			`prog__${student.id}__lesson__${lesson.id}`,
		)) as { completedAt?: string; stepType?: string; stepId?: string } | null;
		expect(lessonRow?.completedAt).toBeDefined();
		expect(lessonRow?.stepType).toBe("lesson");
		expect(lessonRow?.stepId).toBe(lesson.id);
	});

	it("rejects startAttempt when quiz is not attached to the lesson (H2)", async () => {
		const { ctx } = await newCtx();
		const otherQuiz = await seedQuiz(ctx, { questions: [mcqCorrect] });
		const targetQuiz = await seedQuiz(ctx, { questions: [mcqCorrect] });
		const student = await seedStudent(ctx, { email: "h2@x.com" });
		const course = await seedCourse(ctx, { title: "H2 Course" });
		// Lesson is attached to otherQuiz, not targetQuiz.
		const lesson = await seedLesson(ctx, { courseId: course.id, quizId: otherQuiz.id });
		await seedEnrollment(ctx, { userId: student.id, courseId: course.id });

		const started = await quizzes.startAttempt(ctx, student.id, targetQuiz.id, lesson.id);
		expect(started.ok).toBe(false);
		if (started.ok) return;
		expect(started.error.code).toBe("LEARN_FORBIDDEN");
	});

	it("rejects startAttempt when user is not enrolled in the course (H1)", async () => {
		const { ctx } = await newCtx();
		const quizRecord = await seedQuiz(ctx, { questions: [mcqCorrect] });
		const student = await seedStudent(ctx, { email: "h1@x.com" });
		const course = await seedCourse(ctx, { title: "H1 Course" });
		const lesson = await seedLesson(ctx, { courseId: course.id, quizId: quizRecord.id });
		// No enrollment created.

		const started = await quizzes.startAttempt(ctx, student.id, quizRecord.id, lesson.id);
		expect(started.ok).toBe(false);
		if (started.ok) return;
		expect(started.error.code).toBe("LEARN_NOT_ENROLLED");
	});

	it("accepts submit with empty answers array (M8)", async () => {
		const { ctx } = await newCtx();
		const { quizRecord, student, lesson } = await seedQuizCtx(ctx, [mcqCorrect], "m8@x.com");
		const started = await quizzes.startAttempt(ctx, student.id, quizRecord.id, lesson.id);
		if (!started.ok) throw new Error("setup failed");
		const submitted = await quizzes.submitAttempt(ctx, started.data.attemptId, []);
		expect(submitted.ok).toBe(true);
		if (!submitted.ok) return;
		expect(submitted.data.score).toBe(0);
		expect(submitted.data.passed).toBe(false);
	});

	it("grades French-labeled true/false by option id (M1 — no text-matching)", async () => {
		const vraiId = "vrai";
		const fauxId = "faux";
		const frTf = {
			id: "q1",
			type: "true_false" as const,
			prompt: "Le ciel est bleu.",
			points: 1,
			// Correct option is labeled "Vrai" — text-based lookup would fail for French.
			options: [
				{ id: vraiId, text: "Vrai", correct: true },
				{ id: fauxId, text: "Faux", correct: false },
			],
		};
		const { ctx } = await newCtx();
		const { quizRecord, student, lesson } = await seedQuizCtx(ctx, [frTf], "fr@x.com");
		const started = await quizzes.startAttempt(ctx, student.id, quizRecord.id, lesson.id);
		if (!started.ok) throw new Error("setup failed");

		const correct = await quizzes.submitAttempt(ctx, started.data.attemptId, [
			{ questionId: "q1", answer: vraiId },
		]);
		expect(correct.ok).toBe(true);
		if (!correct.ok) return;
		expect(correct.data.passed).toBe(true);
	});
});

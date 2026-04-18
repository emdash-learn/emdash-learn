/**
 * Quizzes engine (T08 / §22 / §5.3 / §6.1 + §6.3).
 *
 * Contents:
 *   - `grade()` — the **pure** scoring function. Sole source of truth for
 *     "did the student pass?" — no `ctx`, no storage, no event bus. Every
 *     other code path (route, reconciler, preview) calls into it. Handles
 *     mcq / multi / true_false / short_text, reports overtime separately
 *     from pass/fail (policy enforcement is a route concern, per the
 *     T08 unit-test contract).
 *   - `create` / `update` / `remove` / `list` — authoring CRUD over the
 *     `quizzes` plugin-storage collection.
 *   - `startAttempt` / `submitAttempt` — student lifecycle. Persists the
 *     attempt, grades it, and — when the attempt is passed and bound to a
 *     lessonId — triggers lesson completion (terminal-quiz-passed rule,
 *     T08 acceptance).
 *
 * Event semantics (§8.2):
 *   - `quiz:attempted` — emitted on every submitAttempt, contains the graded
 *     attempt so analytics / notifications can consume it.
 *   - `lesson:completed` — emitted via `progress.markLessonComplete` when
 *     a passed attempt is bound to a lesson.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { ulid } from "emdash";

import { LEARN_ERRORS } from "../constants.js";
import type {
	Quiz,
	QuizAttempt,
	QuizAttemptAnswer,
	QuizQuestion,
	QuizTimeLimitPolicy,
} from "../types/storage.js";
import { emit } from "./event-bus.js";
import { markLessonComplete } from "./progress.js";
import { err, ok, type Result } from "./result.js";

const QUIZZES = "quizzes";
const QUIZ_ATTEMPTS = "quiz_attempts";

function quizzesStore(ctx: PluginContext): StorageCollection<Quiz> {
	const s = (ctx.storage as Record<string, StorageCollection | undefined>)[QUIZZES];
	if (!s) throw new Error(`Plugin storage collection "${QUIZZES}" is not declared.`);
	return s as StorageCollection<Quiz>;
}

function attemptsStore(ctx: PluginContext): StorageCollection<QuizAttempt> {
	const s = (ctx.storage as Record<string, StorageCollection | undefined>)[QUIZ_ATTEMPTS];
	if (!s) throw new Error(`Plugin storage collection "${QUIZ_ATTEMPTS}" is not declared.`);
	return s as StorageCollection<QuizAttempt>;
}

// ---------------------------------------------------------------------------
// PURE: grade() — T08 core, §21 Phase 3 spec
// ---------------------------------------------------------------------------

export interface QuestionFeedback {
	questionId: string;
	correct: boolean;
	pointsAwarded: number;
	pointsPossible: number;
	explanation?: string;
}

export interface GradeResult {
	score: number; // 0..100 integer
	passed: boolean;
	feedback: QuestionFeedback[];
	overtime: boolean;
}

function normalizeText(v: unknown): string {
	if (typeof v !== "string") return "";
	return v.trim().toLowerCase();
}

function gradeMcq(q: QuizQuestion, raw: unknown): boolean {
	if (typeof raw !== "string") return false;
	const correct = q.options?.find((o) => o.correct);
	return Boolean(correct && correct.id === raw);
}

function gradeMulti(q: QuizQuestion, raw: unknown): boolean {
	if (!Array.isArray(raw)) return false;
	const submitted = new Set(raw.filter((x): x is string => typeof x === "string"));
	if (submitted.size !== raw.length) return false;
	const correct = new Set((q.options ?? []).filter((o) => o.correct).map((o) => o.id));
	if (submitted.size !== correct.size) return false;
	for (const id of correct) if (!submitted.has(id)) return false;
	return true;
}

function gradeTrueFalse(q: QuizQuestion, raw: unknown): boolean {
	const options = q.options ?? [];
	const truthyId = options.find((o) => /^true$/i.test(o.text))?.id;
	const falsyId = options.find((o) => /^false$/i.test(o.text))?.id;
	let submittedId: string | undefined;
	if (typeof raw === "boolean") submittedId = raw ? truthyId : falsyId;
	else if (typeof raw === "string") submittedId = raw;
	if (!submittedId) return false;
	const correct = options.find((o) => o.correct);
	return Boolean(correct && correct.id === submittedId);
}

function gradeShortText(q: QuizQuestion, raw: unknown): boolean {
	const submitted = normalizeText(raw);
	if (!submitted) return false;
	for (const opt of q.options ?? []) {
		if (!opt.correct) continue;
		if (normalizeText(opt.text) === submitted) return true;
	}
	return false;
}

function gradeOne(q: QuizQuestion, raw: unknown): boolean {
	switch (q.type) {
		case "mcq":
			return gradeMcq(q, raw);
		case "multi":
			return gradeMulti(q, raw);
		case "true_false":
			return gradeTrueFalse(q, raw);
		case "short_text":
			return gradeShortText(q, raw);
	}
}

function isOvertime(attempt: QuizAttempt, quiz: Quiz, now: Date): boolean {
	if (!quiz.timeLimit || quiz.timeLimit <= 0) return false;
	const startedMs = Date.parse(attempt.startedAt);
	if (Number.isNaN(startedMs)) return false;
	const referenceMs = attempt.submittedAt ? Date.parse(attempt.submittedAt) : now.getTime();
	if (Number.isNaN(referenceMs)) return false;
	const elapsedSeconds = (referenceMs - startedMs) / 1000;
	return elapsedSeconds > quiz.timeLimit;
}

/**
 * Pure grading. Policy-agnostic: `overtime` is reported but the decision to
 * reject or accept a late submit is a route concern.
 */
export function grade(attempt: QuizAttempt, quiz: Quiz, now: Date): GradeResult {
	const answers = new Map<string, unknown>();
	for (const a of attempt.answers ?? []) answers.set(a.questionId, a.answer);

	let totalPossible = 0;
	let totalAwarded = 0;
	const feedback: QuestionFeedback[] = [];

	for (const q of quiz.questions) {
		const raw = answers.get(q.id);
		const hasAnswer = raw !== undefined;
		const correct = hasAnswer ? gradeOne(q, raw) : false;
		const points = q.points ?? 0;
		totalPossible += points;
		const awarded = correct ? points : 0;
		totalAwarded += awarded;
		const entry: QuestionFeedback = {
			questionId: q.id,
			correct,
			pointsAwarded: awarded,
			pointsPossible: points,
		};
		if (q.explanation !== undefined) entry.explanation = q.explanation;
		feedback.push(entry);
	}

	const score = totalPossible > 0 ? Math.round((totalAwarded / totalPossible) * 100) : 0;
	const passed = score >= quiz.passingScore;
	const overtime = isOvertime(attempt, quiz, now);

	return { score, passed, feedback, overtime };
}

// ---------------------------------------------------------------------------
// CRUD (§6.3)
// ---------------------------------------------------------------------------

export interface QuizInput {
	title: string;
	description?: string;
	passingScore: number;
	timeLimit?: number;
	timeLimitPolicy?: QuizTimeLimitPolicy;
	randomize?: boolean;
	questions: QuizQuestion[];
}

export interface QuizRecord {
	id: string;
	data: Quiz;
}

function validateQuizInput(input: {
	passingScore?: number;
	questions?: unknown;
}): Result<true> | null {
	if (
		input.questions !== undefined &&
		(!Array.isArray(input.questions) || input.questions.length === 0)
	) {
		return err(LEARN_ERRORS.FORBIDDEN, "quiz must have at least one question");
	}
	if (
		typeof input.passingScore === "number" &&
		(input.passingScore < 0 || input.passingScore > 100)
	) {
		return err(LEARN_ERRORS.FORBIDDEN, "passingScore must be between 0 and 100");
	}
	return null;
}

export async function create(ctx: PluginContext, input: QuizInput): Promise<Result<QuizRecord>> {
	const invalid = validateQuizInput(input);
	if (invalid) return invalid as Result<QuizRecord>;

	const id = `quiz_${ulid()}`;
	const now = new Date().toISOString();
	const data: Quiz = {
		title: input.title,
		passingScore: input.passingScore,
		timeLimitPolicy: input.timeLimitPolicy ?? "hard",
		randomize: input.randomize ?? false,
		questions: input.questions,
		createdAt: now,
		updatedAt: now,
	};
	if (input.description !== undefined) data.description = input.description;
	if (input.timeLimit !== undefined) data.timeLimit = input.timeLimit;

	await quizzesStore(ctx).put(id, data);
	ctx.log.info("quiz created", { id, title: data.title });
	return ok({ id, data });
}

export async function update(
	ctx: PluginContext,
	quizId: string,
	patch: Partial<QuizInput>,
): Promise<Result<QuizRecord>> {
	const existing = await quizzesStore(ctx).get(quizId);
	if (!existing) return err(LEARN_ERRORS.SETUP_INCOMPLETE, `Quiz ${quizId} not found`);
	const invalid = validateQuizInput(patch);
	if (invalid) return invalid as Result<QuizRecord>;

	const merged: Quiz = {
		...existing,
		...patch,
		questions: patch.questions ?? existing.questions,
		updatedAt: new Date().toISOString(),
	};
	// `passingScore` must stay a number — patch may omit it so fall back to existing.
	if (patch.passingScore !== undefined) merged.passingScore = patch.passingScore;
	if (patch.timeLimitPolicy !== undefined) merged.timeLimitPolicy = patch.timeLimitPolicy;

	await quizzesStore(ctx).put(quizId, merged);
	return ok({ id: quizId, data: merged });
}

export async function remove(ctx: PluginContext, quizId: string): Promise<Result<void>> {
	const existing = await quizzesStore(ctx).get(quizId);
	if (!existing) return ok(undefined); // Idempotent delete.
	await quizzesStore(ctx).delete(quizId);
	return ok(undefined);
}

export interface ListOptions {
	cursor?: string;
	limit?: number;
}

export interface PaginatedQuizzes {
	items: QuizRecord[];
	cursor?: string;
	hasMore: boolean;
}

export async function list(
	ctx: PluginContext,
	opts: ListOptions = {},
): Promise<Result<PaginatedQuizzes>> {
	const page = await quizzesStore(ctx).query({
		limit: opts.limit,
		cursor: opts.cursor,
		orderBy: { updatedAt: "desc" },
	});
	const out: PaginatedQuizzes = {
		items: page.items.map((r) => ({ id: r.id, data: r.data })),
		hasMore: page.hasMore,
	};
	if (page.cursor !== undefined) out.cursor = page.cursor;
	return ok(out);
}

// ---------------------------------------------------------------------------
// Student lifecycle: startAttempt + submitAttempt (§6.1)
// ---------------------------------------------------------------------------

export interface QuestionForStudent {
	id: string;
	type: QuizQuestion["type"];
	prompt: string;
	points: number;
	options?: Array<{ id: string; text: string }>;
}

export interface StartAttemptResult {
	attemptId: string;
	questions: QuestionForStudent[];
	startedAt: string;
	timeLimit?: number;
	timeLimitPolicy: QuizTimeLimitPolicy;
}

/**
 * Strip the `correct` flag + `explanation` from options before handing
 * questions to the student — server-authoritative scoring requires the
 * student never sees which option is correct.
 */
function sanitizeForStudent(quiz: Quiz): QuestionForStudent[] {
	return quiz.questions.map((q) => {
		const out: QuestionForStudent = {
			id: q.id,
			type: q.type,
			prompt: q.prompt,
			points: q.points,
		};
		if (q.options) {
			out.options = q.options.map((o) => ({ id: o.id, text: o.text }));
		}
		return out;
	});
}

export async function startAttempt(
	ctx: PluginContext,
	userId: string,
	quizId: string,
	lessonId?: string,
): Promise<Result<StartAttemptResult>> {
	const quiz = await quizzesStore(ctx).get(quizId);
	if (!quiz) return err(LEARN_ERRORS.SETUP_INCOMPLETE, `Quiz ${quizId} not found`);

	const id = `qa_${ulid()}`;
	const startedAt = new Date().toISOString();
	const attempt: QuizAttempt = {
		userId,
		quizId,
		startedAt,
		answers: [],
	};
	if (lessonId !== undefined) attempt.lessonId = lessonId;
	await attemptsStore(ctx).put(id, attempt);

	const out: StartAttemptResult = {
		attemptId: id,
		questions: sanitizeForStudent(quiz),
		startedAt,
		timeLimitPolicy: quiz.timeLimitPolicy,
	};
	if (quiz.timeLimit !== undefined) out.timeLimit = quiz.timeLimit;
	return ok(out);
}

export interface SubmittedAnswer {
	questionId: string;
	answer: unknown;
}

export interface SubmitAttemptResult {
	score: number;
	passed: boolean;
	feedback: QuestionFeedback[];
	overtime: boolean;
}

export async function submitAttempt(
	ctx: PluginContext,
	attemptId: string,
	answers: SubmittedAnswer[],
): Promise<Result<SubmitAttemptResult>> {
	const attempt = await attemptsStore(ctx).get(attemptId);
	if (!attempt) return err(LEARN_ERRORS.QUIZ_NOT_STARTED, `Attempt ${attemptId} not found`);
	if (attempt.submittedAt) {
		return err(LEARN_ERRORS.QUIZ_NOT_STARTED, `Attempt ${attemptId} already submitted`);
	}
	const quiz = await quizzesStore(ctx).get(attempt.quizId);
	if (!quiz) return err(LEARN_ERRORS.SETUP_INCOMPLETE, `Quiz ${attempt.quizId} not found`);

	const now = new Date();
	const submittedAt = now.toISOString();
	const finalized: QuizAttempt = {
		...attempt,
		answers: answers as QuizAttemptAnswer[],
		submittedAt,
	};

	const graded = grade(finalized, quiz, now);

	// Hard policy: refuse to persist a passed result if the student is overtime.
	// The attempt row stamps submittedAt + overtime=true + passed=false so the
	// UI + analytics see the timeout.
	const hardTimeout = quiz.timeLimitPolicy === "hard" && graded.overtime;
	const persistedPassed = hardTimeout ? false : graded.passed;

	finalized.score = graded.score;
	finalized.passed = persistedPassed;
	finalized.overtime = graded.overtime;
	await attemptsStore(ctx).put(attemptId, finalized);

	await emit(
		{
			name: "quiz:attempted",
			key: `qa:${attemptId}`,
			data: finalized,
		},
		ctx,
	);

	if (hardTimeout) {
		return err(LEARN_ERRORS.QUIZ_TIMEOUT, "quiz submitted past the hard time limit");
	}

	// Terminal-quiz-passed: mark the lesson complete. Route level binds the
	// attempt to a lessonId — passing + lessonId means this quiz is the
	// lesson's terminal assessment.
	if (persistedPassed && attempt.lessonId) {
		const completed = await markLessonComplete(ctx, attempt.userId, attempt.lessonId);
		if (!completed.ok) {
			// Don't fail the submit — the attempt grading succeeded; the lesson
			// completion will be swept by the reconciler on the next cron tick.
			ctx.log.warn("quiz: lesson completion failed after pass", {
				attemptId,
				code: completed.error.code,
			});
		}
	}

	return ok({
		score: graded.score,
		passed: persistedPassed,
		feedback: graded.feedback,
		overtime: graded.overtime,
	});
}

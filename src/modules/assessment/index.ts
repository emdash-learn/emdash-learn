import type { VerifiedLearner } from "../learner-principal.js";

const MAX_TITLE_LENGTH = 200;
const MAX_ID_LENGTH = 200;

export interface ChoiceOption {
	id: string;
	text: string;
}

interface QuestionBase {
	id: string;
	prompt: string;
	points: number;
	explanation?: string;
}

export interface SingleChoiceQuestion extends QuestionBase {
	type: "single_choice";
	options: ChoiceOption[];
	correctOptionId: string;
}

export interface MultipleChoiceQuestion extends QuestionBase {
	type: "multiple_choice";
	options: ChoiceOption[];
	correctOptionIds: string[];
}

export interface TrueFalseQuestion extends QuestionBase {
	type: "true_false";
	correctAnswer: boolean;
}

export interface ShortTextQuestion extends QuestionBase {
	type: "short_text";
	acceptedAnswers: string[];
}

export type DraftQuestion =
	SingleChoiceQuestion | MultipleChoiceQuestion | TrueFalseQuestion | ShortTextQuestion;

export interface DraftCheckInput {
	courseId: string;
	title: string;
	description?: string;
	passingScore: number;
	questions: DraftQuestion[];
}

export interface DraftCheck extends DraftCheckInput {
	checkId: string;
	createdAt: string;
	updatedAt: string;
}

export type PublicQuestion =
	| Omit<SingleChoiceQuestion, "correctOptionId" | "explanation">
	| Omit<MultipleChoiceQuestion, "correctOptionIds" | "explanation">
	| Omit<TrueFalseQuestion, "correctAnswer" | "explanation">
	| Omit<ShortTextQuestion, "acceptedAnswers" | "explanation">;

export interface PublishedCheckPresentation {
	courseId: string;
	checkId: string;
	revisionId: string;
	title: string;
	description?: string;
	passingScore: number;
	questions: PublicQuestion[];
}

export interface SubmittedAnswer {
	questionId: string;
	answer: string | string[] | boolean;
}

export interface CheckSubmission {
	courseId: string;
	checkId: string;
	revisionId: string;
	answers: SubmittedAnswer[];
}

export interface IdempotentCheckSubmission extends CheckSubmission {
	submissionId: string;
}

export interface QuestionResult {
	questionId: string;
	correct: boolean;
	pointsAwarded: number;
	pointsPossible: number;
	explanation?: string;
}

export interface CheckResult {
	courseId: string;
	checkId: string;
	revisionId: string;
	score: number;
	passed: boolean;
	pointsAwarded: number;
	pointsPossible: number;
	questions: QuestionResult[];
}

export type PersistedQuestionResult = Omit<QuestionResult, "explanation">;

export interface PersistedCheckResult extends Omit<CheckResult, "questions"> {
	attemptId: string;
	submissionId: string;
	submittedAt: string;
	questions: PersistedQuestionResult[];
}

export interface AttemptSubmissionResult extends PersistedCheckResult {
	/** True only for the request that won the durable uniqueness race. */
	newlyRecorded: boolean;
}

export interface AssessmentRevisionRecord {
	courseId: string;
	checkId: string;
	revisionId: string;
	content: Omit<DraftCheckInput, "courseId">;
	publishedAt: string;
}

export interface AssessmentAttemptRecord {
	learnerKey: string;
	submissionId: string;
	courseId: string;
	fingerprint: string;
	result: PersistedCheckResult;
}

/**
 * Local-substitutable persistence seam for the Assessment module.
 *
 * `listDrafts` and `listAttempts` must consume every underlying storage page
 * and return the full matching set; transport pagination never leaks into the
 * Assessment interface. Draft writes upsert, draft deletion is idempotent,
 * revision creation must not overwrite an existing revision, and completed
 * writes must be visible to subsequent reads.
 *
 * Attempt creation is protected by the declared unique composite
 * `(learnerKey, submissionId)`. `createAttempt` must never update an existing
 * row: it returns `duplicate` when that composite loses a concurrent race.
 */
export interface AssessmentStorage {
	getDraft(checkId: string): Promise<DraftCheck | undefined>;
	putDraft(draft: DraftCheck): Promise<void>;
	deleteDraft(checkId: string): Promise<void>;
	listDrafts(): Promise<DraftCheck[]>;
	getRevision(revisionId: string): Promise<AssessmentRevisionRecord | undefined>;
	createRevision(revision: AssessmentRevisionRecord): Promise<void>;
	getHead(checkId: string): Promise<string | undefined>;
	setHead(checkId: string, revisionId: string): Promise<void>;
	/** Removes only the current head pointer and reports whether one existed. */
	archiveHead(checkId: string): Promise<boolean>;
	getAttempt(
		learnerKey: string,
		submissionId: string,
	): Promise<AssessmentAttemptRecord | undefined>;
	createAttempt(
		attemptId: string,
		attempt: AssessmentAttemptRecord,
	): Promise<"created" | "duplicate">;
	listAttempts(learnerKey: string): Promise<AssessmentAttemptRecord[]>;
	eraseLearnerAttempts(learnerKey: string): Promise<number>;
}

export interface AssessmentDependencies {
	storage: AssessmentStorage;
	clock: {
		now(): string;
	};
	ids: {
		/** Returns a fresh opaque id that contains no learner data. */
		next(kind: "check" | "revision" | "attempt"): string;
	};
	hash: {
		/**
		 * Returns a stable, key-safe, one-way digest. Production adapters should
		 * use a keyed cryptographic digest so low-entropy submitted text cannot
		 * be recovered from a persisted fingerprint.
		 */
		digest(value: string): Promise<string>;
	};
}

export interface Assessment {
	createDraft(input: DraftCheckInput): Promise<DraftCheck>;
	getDraft(checkId: string): Promise<DraftCheck | null>;
	listDrafts(): Promise<DraftCheck[]>;
	updateDraft(checkId: string, input: DraftCheckInput): Promise<DraftCheck | null>;
	deleteDraft(checkId: string): Promise<void>;
	publish(checkId: string): Promise<PublishedCheckPresentation | null>;
	archive(checkId: string): Promise<boolean>;
	present(input: { courseId: string; checkId: string }): Promise<PublishedCheckPresentation | null>;
	selfGrade(input: CheckSubmission): Promise<CheckResult>;
	submitAttempt(
		learner: VerifiedLearner,
		input: IdempotentCheckSubmission,
	): Promise<AttemptSubmissionResult>;
	listAttempts(
		learner: VerifiedLearner,
		input: { checkId?: string },
	): Promise<PersistedCheckResult[]>;
	eraseLearnerAttempts(learner: VerifiedLearner): Promise<number>;
}

export type AssessmentErrorCode =
	"INVALID_DRAFT" | "INVALID_SUBMISSION" | "NOT_FOUND" | "SUBMISSION_CONFLICT";

export class AssessmentError extends Error {
	readonly code: AssessmentErrorCode;

	constructor(code: AssessmentErrorCode, message: string) {
		super(message);
		this.name = "AssessmentError";
		this.code = code;
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function assertUnreachable(value: never): never {
	throw new Error(`Unsupported Assessment value: ${String(value)}`);
}

function optionIds(options: ChoiceOption[], questionIndex: number): Set<string> {
	if (options.length < 2) {
		throw new AssessmentError(
			"INVALID_DRAFT",
			`questions[${questionIndex}].options must contain at least two options.`,
		);
	}
	const ids = new Set<string>();
	for (const [optionIndex, option] of options.entries()) {
		if (option.id.trim().length === 0) {
			throw new AssessmentError(
				"INVALID_DRAFT",
				`questions[${questionIndex}].options[${optionIndex}].id must not be blank.`,
			);
		}
		if (option.text.trim().length === 0) {
			throw new AssessmentError(
				"INVALID_DRAFT",
				`questions[${questionIndex}].options[${optionIndex}].text must not be blank.`,
			);
		}
		if (ids.has(option.id)) {
			throw new AssessmentError(
				"INVALID_DRAFT",
				`questions[${questionIndex}].options must use unique ids; "${option.id}" repeats.`,
			);
		}
		ids.add(option.id);
	}
	return ids;
}

function validateDraft(input: DraftCheckInput): void {
	if (input.courseId.trim().length === 0 || input.courseId.length > MAX_ID_LENGTH) {
		throw new AssessmentError(
			"INVALID_DRAFT",
			`courseId must contain from 1 through ${MAX_ID_LENGTH} characters.`,
		);
	}
	if (input.title.trim().length === 0) {
		throw new AssessmentError("INVALID_DRAFT", "title must not be blank.");
	}
	if (input.title.length > MAX_TITLE_LENGTH) {
		throw new AssessmentError(
			"INVALID_DRAFT",
			`title must not exceed ${MAX_TITLE_LENGTH} characters.`,
		);
	}
	if (!Number.isInteger(input.passingScore) || input.passingScore < 0 || input.passingScore > 100) {
		throw new AssessmentError(
			"INVALID_DRAFT",
			"passingScore must be an integer from 0 through 100.",
		);
	}
	const questionIds = new Set<string>();
	for (const [index, question] of input.questions.entries()) {
		if (question.id.trim().length === 0) {
			throw new AssessmentError("INVALID_DRAFT", `questions[${index}].id must not be blank.`);
		}
		if (question.prompt.trim().length === 0) {
			throw new AssessmentError("INVALID_DRAFT", `questions[${index}].prompt must not be blank.`);
		}
		if (!Number.isInteger(question.points) || question.points <= 0) {
			throw new AssessmentError(
				"INVALID_DRAFT",
				`questions[${index}].points must be a positive integer.`,
			);
		}
		if (questionIds.has(question.id)) {
			throw new AssessmentError(
				"INVALID_DRAFT",
				`questions must use unique ids; "${question.id}" repeats.`,
			);
		}
		questionIds.add(question.id);

		switch (question.type) {
			case "single_choice": {
				const authoredOptionIds = optionIds(question.options, index);
				if (!authoredOptionIds.has(question.correctOptionId)) {
					throw new AssessmentError(
						"INVALID_DRAFT",
						`questions[${index}].correctOptionId must reference one of that question's options.`,
					);
				}
				break;
			}
			case "multiple_choice": {
				const authoredOptionIds = optionIds(question.options, index);
				if (question.correctOptionIds.length === 0) {
					throw new AssessmentError(
						"INVALID_DRAFT",
						`questions[${index}].correctOptionIds must contain at least one option id.`,
					);
				}
				if (new Set(question.correctOptionIds).size !== question.correctOptionIds.length) {
					throw new AssessmentError(
						"INVALID_DRAFT",
						`questions[${index}].correctOptionIds must not contain duplicates.`,
					);
				}
				if (!question.correctOptionIds.every((optionId) => authoredOptionIds.has(optionId))) {
					throw new AssessmentError(
						"INVALID_DRAFT",
						`questions[${index}].correctOptionIds must reference only that question's options.`,
					);
				}
				break;
			}
			case "true_false":
				if (typeof question.correctAnswer !== "boolean") {
					throw new AssessmentError(
						"INVALID_DRAFT",
						`questions[${index}].correctAnswer must be a boolean.`,
					);
				}
				break;
			case "short_text": {
				if (
					!question.acceptedAnswers.some(
						(answer) => typeof answer === "string" && answer.trim().length > 0,
					)
				) {
					throw new AssessmentError(
						"INVALID_DRAFT",
						`questions[${index}].acceptedAnswers must contain at least one nonblank answer.`,
					);
				}
				if (
					question.acceptedAnswers.some(
						(answer) => typeof answer !== "string" || answer.trim().length === 0,
					)
				) {
					throw new AssessmentError(
						"INVALID_DRAFT",
						`questions[${index}].acceptedAnswers must not contain blank answers.`,
					);
				}
				const normalizedAnswers = question.acceptedAnswers.map(normalizeText);
				if (new Set(normalizedAnswers).size !== normalizedAnswers.length) {
					throw new AssessmentError(
						"INVALID_DRAFT",
						`questions[${index}].acceptedAnswers must be unique after trimming and case normalization.`,
					);
				}
				break;
			}
		}
	}
}

function toPublicQuestion(question: DraftQuestion): PublicQuestion {
	switch (question.type) {
		case "single_choice": {
			return {
				id: question.id,
				type: "single_choice",
				prompt: question.prompt,
				points: question.points,
				options: question.options.map(({ id, text }) => ({ id, text })),
			};
		}
		case "multiple_choice": {
			return {
				id: question.id,
				type: "multiple_choice",
				prompt: question.prompt,
				points: question.points,
				options: question.options.map(({ id, text }) => ({ id, text })),
			};
		}
		case "true_false": {
			return {
				id: question.id,
				type: "true_false",
				prompt: question.prompt,
				points: question.points,
			};
		}
		case "short_text": {
			return {
				id: question.id,
				type: "short_text",
				prompt: question.prompt,
				points: question.points,
			};
		}
	}
	return assertUnreachable(question);
}

function presentRevision(revision: AssessmentRevisionRecord): PublishedCheckPresentation {
	const presentation: PublishedCheckPresentation = {
		courseId: revision.courseId,
		checkId: revision.checkId,
		revisionId: revision.revisionId,
		title: revision.content.title,
		passingScore: revision.content.passingScore,
		questions: revision.content.questions.map(toPublicQuestion),
	};
	if (revision.content.description !== undefined) {
		presentation.description = revision.content.description;
	}
	return presentation;
}

function gradeSingleChoice(question: SingleChoiceQuestion, answer: unknown): boolean {
	return typeof answer === "string" && answer === question.correctOptionId;
}

function gradeMultipleChoice(question: MultipleChoiceQuestion, answer: unknown): boolean {
	if (!Array.isArray(answer) || !answer.every((value) => typeof value === "string")) return false;
	const submitted = new Set(answer);
	const expected = new Set(question.correctOptionIds);
	return (
		submitted.size === answer.length &&
		submitted.size === expected.size &&
		[...expected].every((optionId) => submitted.has(optionId))
	);
}

function normalizeText(value: string): string {
	return value.trim().toLocaleLowerCase("en-US");
}

function gradeQuestion(question: DraftQuestion, answer: unknown): boolean {
	switch (question.type) {
		case "single_choice": {
			return gradeSingleChoice(question, answer);
		}
		case "multiple_choice": {
			return gradeMultipleChoice(question, answer);
		}
		case "true_false": {
			return typeof answer === "boolean" && answer === question.correctAnswer;
		}
		case "short_text": {
			if (typeof answer !== "string" || normalizeText(answer).length === 0) return false;
			const submitted = normalizeText(answer);
			return question.acceptedAnswers.some(
				(acceptedAnswer) => normalizeText(acceptedAnswer) === submitted,
			);
		}
	}
	return assertUnreachable(question);
}

function validateSubmission(revision: AssessmentRevisionRecord, answers: SubmittedAnswer[]): void {
	const revisionQuestionIds = new Set(revision.content.questions.map((question) => question.id));
	const submittedQuestionIds = new Set<string>();
	for (const [index, answer] of answers.entries()) {
		if (submittedQuestionIds.has(answer.questionId)) {
			throw new AssessmentError(
				"INVALID_SUBMISSION",
				`answers must use unique question ids; "${answer.questionId}" repeats.`,
			);
		}
		submittedQuestionIds.add(answer.questionId);
		if (!revisionQuestionIds.has(answer.questionId)) {
			throw new AssessmentError(
				"INVALID_SUBMISSION",
				`answers[${index}].questionId "${answer.questionId}" is not part of this revision.`,
			);
		}
	}
}

function gradeRevision(
	revision: AssessmentRevisionRecord,
	answers: SubmittedAnswer[],
): CheckResult {
	validateSubmission(revision, answers);
	const answersByQuestion = new Map(
		answers.map(({ questionId, answer }) => [questionId, answer] as const),
	);
	let pointsAwarded = 0;
	let pointsPossible = 0;
	const questions = revision.content.questions.map((question): QuestionResult => {
		const correct = gradeQuestion(question, answersByQuestion.get(question.id));
		const awarded = correct ? question.points : 0;
		pointsAwarded += awarded;
		pointsPossible += question.points;
		const result: QuestionResult = {
			questionId: question.id,
			correct,
			pointsAwarded: awarded,
			pointsPossible: question.points,
		};
		if (question.explanation !== undefined) result.explanation = question.explanation;
		return result;
	});
	const score = pointsPossible === 0 ? 0 : Math.round((pointsAwarded / pointsPossible) * 100);
	return {
		courseId: revision.courseId,
		checkId: revision.checkId,
		revisionId: revision.revisionId,
		score,
		passed: score >= revision.content.passingScore,
		pointsAwarded,
		pointsPossible,
		questions,
	};
}

function canonicalSubmission(input: CheckSubmission): string {
	return JSON.stringify({
		courseId: input.courseId,
		checkId: input.checkId,
		revisionId: input.revisionId,
		answers: input.answers,
	});
}

function persistedResult(
	grade: CheckResult,
	input: {
		attemptId: string;
		submissionId: string;
		submittedAt: string;
	},
): PersistedCheckResult {
	return {
		courseId: grade.courseId,
		checkId: grade.checkId,
		revisionId: grade.revisionId,
		score: grade.score,
		passed: grade.passed,
		pointsAwarded: grade.pointsAwarded,
		pointsPossible: grade.pointsPossible,
		questions: grade.questions.map(({ questionId, correct, pointsAwarded, pointsPossible }) => ({
			questionId,
			correct,
			pointsAwarded,
			pointsPossible,
		})),
		attemptId: input.attemptId,
		submissionId: input.submissionId,
		submittedAt: input.submittedAt,
	};
}

function safePersistedResult(result: PersistedCheckResult): PersistedCheckResult {
	return {
		courseId: result.courseId,
		checkId: result.checkId,
		revisionId: result.revisionId,
		score: result.score,
		passed: result.passed,
		pointsAwarded: result.pointsAwarded,
		pointsPossible: result.pointsPossible,
		questions: result.questions.map(({ questionId, correct, pointsAwarded, pointsPossible }) => ({
			questionId,
			correct,
			pointsAwarded,
			pointsPossible,
		})),
		attemptId: result.attemptId,
		submissionId: result.submissionId,
		submittedAt: result.submittedAt,
	};
}

function resolveAttempt(
	attempt: AssessmentAttemptRecord,
	fingerprint: string,
): AttemptSubmissionResult {
	if (attempt.fingerprint !== fingerprint) {
		throw new AssessmentError(
			"SUBMISSION_CONFLICT",
			"This submission id was already used for different answers.",
		);
	}
	return { ...safePersistedResult(attempt.result), newlyRecorded: false };
}

export function createInMemoryAssessmentStorage(): AssessmentStorage {
	const drafts = new Map<string, DraftCheck>();
	const revisions = new Map<string, AssessmentRevisionRecord>();
	const heads = new Map<string, string>();
	const attempts = new Map<string, AssessmentAttemptRecord>();

	return {
		async getDraft(checkId) {
			const draft = drafts.get(checkId);
			return draft === undefined ? undefined : clone(draft);
		},
		async putDraft(draft) {
			drafts.set(draft.checkId, clone(draft));
		},
		async deleteDraft(checkId) {
			drafts.delete(checkId);
		},
		async listDrafts() {
			return [...drafts.values()].map((draft) => clone(draft));
		},
		async getRevision(revisionId) {
			const revision = revisions.get(revisionId);
			return revision === undefined ? undefined : clone(revision);
		},
		async createRevision(revision) {
			if (revisions.has(revision.revisionId)) {
				throw new Error(`Revision "${revision.revisionId}" already exists.`);
			}
			revisions.set(revision.revisionId, clone(revision));
		},
		async getHead(checkId) {
			return heads.get(checkId);
		},
		async setHead(checkId, revisionId) {
			heads.set(checkId, revisionId);
		},
		async archiveHead(checkId) {
			return heads.delete(checkId);
		},
		async getAttempt(learnerKey, submissionId) {
			const attempt = [...attempts.values()].find(
				(candidate) =>
					candidate.learnerKey === learnerKey && candidate.submissionId === submissionId,
			);
			return attempt === undefined ? undefined : clone(attempt);
		},
		async createAttempt(attemptId, attempt) {
			const duplicate = [...attempts.values()].some(
				(candidate) =>
					candidate.learnerKey === attempt.learnerKey &&
					candidate.submissionId === attempt.submissionId,
			);
			if (duplicate) return "duplicate";
			if (attempts.has(attemptId)) {
				throw new Error(`Attempt "${attemptId}" already exists.`);
			}
			attempts.set(attemptId, clone(attempt));
			return "created";
		},
		async listAttempts(learnerKey) {
			return [...attempts.values()]
				.filter((attempt) => attempt.learnerKey === learnerKey)
				.map((attempt) => clone(attempt));
		},
		async eraseLearnerAttempts(learnerKey) {
			let erased = 0;
			for (const [key, attempt] of attempts) {
				if (attempt.learnerKey !== learnerKey) continue;
				attempts.delete(key);
				erased += 1;
			}
			return erased;
		},
	};
}

export function createAssessment(dependencies: AssessmentDependencies): Assessment {
	async function learnerKey(learner: VerifiedLearner): Promise<string> {
		return dependencies.hash.digest(JSON.stringify(["learner", learner.learnerId]));
	}

	return {
		async createDraft(input) {
			validateDraft(input);
			const now = dependencies.clock.now();
			const draft: DraftCheck = {
				...clone(input),
				checkId: dependencies.ids.next("check"),
				createdAt: now,
				updatedAt: now,
			};
			await dependencies.storage.putDraft(draft);
			return clone(draft);
		},

		async getDraft(checkId) {
			const draft = await dependencies.storage.getDraft(checkId);
			return draft === undefined ? null : clone(draft);
		},

		async listDrafts() {
			const drafts = await dependencies.storage.listDrafts();
			return (
				drafts
					.map(clone)
					// oxlint-disable-next-line no-array-sort -- sorting a new local array under ES2022
					.sort(
						(left, right) =>
							right.updatedAt.localeCompare(left.updatedAt) ||
							left.checkId.localeCompare(right.checkId),
					)
			);
		},

		async updateDraft(checkId, input) {
			validateDraft(input);
			const existing = await dependencies.storage.getDraft(checkId);
			if (existing === undefined) return null;
			const draft: DraftCheck = {
				...clone(input),
				checkId,
				createdAt: existing.createdAt,
				updatedAt: dependencies.clock.now(),
			};
			await dependencies.storage.putDraft(draft);
			return clone(draft);
		},

		async deleteDraft(checkId) {
			await dependencies.storage.deleteDraft(checkId);
		},

		async publish(checkId) {
			const draft = await dependencies.storage.getDraft(checkId);
			if (draft === undefined) return null;
			if (draft.questions.length === 0) {
				throw new AssessmentError(
					"INVALID_DRAFT",
					"A published Knowledge Check must contain at least one question.",
				);
			}
			const revisionId = dependencies.ids.next("revision");
			const revision: AssessmentRevisionRecord = {
				courseId: draft.courseId,
				checkId,
				revisionId,
				content: {
					title: draft.title,
					passingScore: draft.passingScore,
					questions: clone(draft.questions),
				},
				publishedAt: dependencies.clock.now(),
			};
			if (draft.description !== undefined) revision.content.description = draft.description;
			await dependencies.storage.createRevision(revision);
			await dependencies.storage.setHead(checkId, revisionId);
			return presentRevision(revision);
		},

		async archive(checkId) {
			return dependencies.storage.archiveHead(checkId);
		},

		async present(input) {
			const revisionId = await dependencies.storage.getHead(input.checkId);
			if (revisionId === undefined) return null;
			const revision = await dependencies.storage.getRevision(revisionId);
			if (
				revision === undefined ||
				revision.checkId !== input.checkId ||
				revision.courseId !== input.courseId
			) {
				return null;
			}
			return presentRevision(revision);
		},

		async selfGrade(input) {
			const revision = await dependencies.storage.getRevision(input.revisionId);
			if (
				revision === undefined ||
				revision.checkId !== input.checkId ||
				revision.courseId !== input.courseId
			) {
				throw new AssessmentError("NOT_FOUND", "Knowledge Check revision was not found.");
			}
			return gradeRevision(revision, input.answers);
		},

		async submitAttempt(learner, input) {
			if (input.submissionId.trim().length === 0) {
				throw new AssessmentError("INVALID_SUBMISSION", "submissionId must not be blank.");
			}
			const revision = await dependencies.storage.getRevision(input.revisionId);
			if (
				revision === undefined ||
				revision.checkId !== input.checkId ||
				revision.courseId !== input.courseId
			) {
				throw new AssessmentError("NOT_FOUND", "Knowledge Check revision was not found.");
			}
			validateSubmission(revision, input.answers);

			const ownerKey = await learnerKey(learner);
			const fingerprint = await dependencies.hash.digest(canonicalSubmission(input));
			const existing = await dependencies.storage.getAttempt(ownerKey, input.submissionId);
			if (existing !== undefined) {
				return resolveAttempt(existing, fingerprint);
			}

			const grade = gradeRevision(revision, input.answers);
			const attemptId = dependencies.ids.next("attempt");
			const result = persistedResult(grade, {
				attemptId,
				submissionId: input.submissionId,
				submittedAt: dependencies.clock.now(),
			});
			const stored: AssessmentAttemptRecord = {
				learnerKey: ownerKey,
				submissionId: input.submissionId,
				courseId: revision.courseId,
				fingerprint,
				result,
			};
			const created = await dependencies.storage.createAttempt(attemptId, stored);
			if (created === "created") {
				return { ...safePersistedResult(result), newlyRecorded: true };
			}
			const winner = await dependencies.storage.getAttempt(ownerKey, input.submissionId);
			if (winner === undefined) {
				throw new Error(
					"Assessment storage reported a duplicate Attempt without a durable winner.",
				);
			}
			return resolveAttempt(winner, fingerprint);
		},

		async listAttempts(learner, input) {
			const attempts = await dependencies.storage.listAttempts(await learnerKey(learner));
			return (
				attempts
					.map((attempt) => safePersistedResult(attempt.result))
					.filter((attempt) => input.checkId === undefined || attempt.checkId === input.checkId)
					// oxlint-disable-next-line no-array-sort -- sorting a new local array under ES2022
					.sort(
						(left, right) =>
							right.submittedAt.localeCompare(left.submittedAt) ||
							left.attemptId.localeCompare(right.attemptId),
					)
			);
		},

		async eraseLearnerAttempts(learner) {
			return dependencies.storage.eraseLearnerAttempts(await learnerKey(learner));
		},
	};
}

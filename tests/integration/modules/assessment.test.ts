import { describe, expect, it } from "vitest";

import {
	AssessmentError,
	createAssessment,
	createInMemoryAssessmentStorage,
	type Assessment,
	type DraftCheckInput,
} from "../../../src/modules/assessment/index.js";
import type { VerifiedLearner } from "../../../src/modules/learner-principal.js";

function createTestAssessment(): Assessment {
	const ids = ["check_1", "revision_1", "attempt_1"];
	return createAssessment({
		storage: createInMemoryAssessmentStorage(),
		clock: { now: () => "2026-07-26T15:00:00.000Z" },
		ids: { next: () => ids.shift() ?? "unused_id" },
		hash: { digest: async (value) => `digest:${value}` },
	});
}

function validDraft(overrides: Partial<DraftCheckInput> = {}): DraftCheckInput {
	return {
		courseId: "course_safety",
		title: "Safety fundamentals",
		description: "Confirm the key ideas.",
		passingScore: 70,
		questions: [
			{
				id: "question_1",
				type: "single_choice",
				prompt: "Which action is safest?",
				points: 2,
				options: [
					{ id: "option_a", text: "Inspect first" },
					{ id: "option_b", text: "Guess" },
				],
				correctOptionId: "option_a",
				explanation: "Inspection reduces avoidable risk.",
			},
		],
		...overrides,
	};
}

describe("Assessment", () => {
	it("authors a retrievable draft through the Assessment interface", async () => {
		const assessment = createTestAssessment();

		const created = await assessment.createDraft(validDraft());
		const retrieved = await assessment.getDraft(created.checkId);

		expect({ created, retrieved }).toEqual({
			created: {
				checkId: "check_1",
				courseId: "course_safety",
				title: "Safety fundamentals",
				description: "Confirm the key ideas.",
				passingScore: 70,
				questions: [
					{
						id: "question_1",
						type: "single_choice",
						prompt: "Which action is safest?",
						points: 2,
						options: [
							{ id: "option_a", text: "Inspect first" },
							{ id: "option_b", text: "Guess" },
						],
						correctOptionId: "option_a",
						explanation: "Inspection reduces avoidable risk.",
					},
				],
				createdAt: "2026-07-26T15:00:00.000Z",
				updatedAt: "2026-07-26T15:00:00.000Z",
			},
			retrieved: {
				checkId: "check_1",
				courseId: "course_safety",
				title: "Safety fundamentals",
				description: "Confirm the key ideas.",
				passingScore: 70,
				questions: [
					{
						id: "question_1",
						type: "single_choice",
						prompt: "Which action is safest?",
						points: 2,
						options: [
							{ id: "option_a", text: "Inspect first" },
							{ id: "option_b", text: "Guess" },
						],
						correctOptionId: "option_a",
						explanation: "Inspection reduces avoidable risk.",
					},
				],
				createdAt: "2026-07-26T15:00:00.000Z",
				updatedAt: "2026-07-26T15:00:00.000Z",
			},
		});
	});

	it("rejects a blank Knowledge Check title", async () => {
		const assessment = createTestAssessment();

		await expect(assessment.createDraft(validDraft({ title: " \n " }))).rejects.toEqual(
			new AssessmentError("INVALID_DRAFT", "title must not be blank."),
		);
	});

	it("rejects a Knowledge Check title longer than 200 characters", async () => {
		const assessment = createTestAssessment();

		await expect(assessment.createDraft(validDraft({ title: "x".repeat(201) }))).rejects.toEqual(
			new AssessmentError("INVALID_DRAFT", "title must not exceed 200 characters."),
		);
	});

	it.each([-1, 101, 70.5, Number.NaN])(
		"rejects an out-of-range or fractional passing score (%s)",
		async (passingScore) => {
			const assessment = createTestAssessment();

			await expect(assessment.createDraft(validDraft({ passingScore }))).rejects.toEqual(
				new AssessmentError("INVALID_DRAFT", "passingScore must be an integer from 0 through 100."),
			);
		},
	);

	it("rejects a single-choice answer key that is not one of the authored options", async () => {
		const assessment = createTestAssessment();
		const input = validDraft();
		const question = input.questions[0];
		if (!question || question.type !== "single_choice") throw new Error("Invalid test fixture");
		question.correctOptionId = "option_missing";

		await expect(assessment.createDraft(input)).rejects.toEqual(
			new AssessmentError(
				"INVALID_DRAFT",
				"questions[0].correctOptionId must reference one of that question's options.",
			),
		);
	});

	it("authors each supported question type through one draft interface", async () => {
		const assessment = createTestAssessment();
		const questions: DraftCheckInput["questions"] = [
			{
				id: "single",
				type: "single_choice",
				prompt: "Pick one.",
				points: 1,
				options: [
					{ id: "a", text: "A" },
					{ id: "b", text: "B" },
				],
				correctOptionId: "a",
			},
			{
				id: "multiple",
				type: "multiple_choice",
				prompt: "Pick every correct choice.",
				points: 2,
				options: [
					{ id: "a", text: "A" },
					{ id: "b", text: "B" },
					{ id: "c", text: "C" },
				],
				correctOptionIds: ["a", "c"],
			},
			{
				id: "boolean",
				type: "true_false",
				prompt: "Is the statement correct?",
				points: 1,
				correctAnswer: true,
			},
			{
				id: "text",
				type: "short_text",
				prompt: "Name the protocol.",
				points: 3,
				acceptedAnswers: ["TLS", "Transport Layer Security"],
			},
		];

		const created = await assessment.createDraft(validDraft({ questions }));

		expect(created.questions).toEqual(questions);
	});

	it("rejects duplicate question identifiers", async () => {
		const assessment = createTestAssessment();
		const first = validDraft().questions[0];
		if (!first) throw new Error("Invalid test fixture");

		await expect(
			assessment.createDraft(validDraft({ questions: [first, { ...first }] })),
		).rejects.toEqual(
			new AssessmentError("INVALID_DRAFT", 'questions must use unique ids; "question_1" repeats.'),
		);
	});

	it("rejects a blank question identifier", async () => {
		const assessment = createTestAssessment();
		const input = validDraft();
		const question = input.questions[0];
		if (!question) throw new Error("Invalid test fixture");
		question.id = " ";

		await expect(assessment.createDraft(input)).rejects.toEqual(
			new AssessmentError("INVALID_DRAFT", "questions[0].id must not be blank."),
		);
	});

	it("rejects a question without a meaningful prompt", async () => {
		const assessment = createTestAssessment();
		const input = validDraft();
		const question = input.questions[0];
		if (!question) throw new Error("Invalid test fixture");
		question.prompt = " \n ";

		await expect(assessment.createDraft(input)).rejects.toEqual(
			new AssessmentError("INVALID_DRAFT", "questions[0].prompt must not be blank."),
		);
	});

	it("rejects non-positive or fractional question points", async () => {
		const assessment = createTestAssessment();
		const input = validDraft();
		const question = input.questions[0];
		if (!question) throw new Error("Invalid test fixture");
		question.points = 0.5;

		await expect(assessment.createDraft(input)).rejects.toEqual(
			new AssessmentError("INVALID_DRAFT", "questions[0].points must be a positive integer."),
		);
	});

	it("rejects duplicate option identifiers inside one question", async () => {
		const assessment = createTestAssessment();
		const input = validDraft();
		const question = input.questions[0];
		if (!question || question.type !== "single_choice") throw new Error("Invalid test fixture");
		question.options[1] = { id: "option_a", text: "A duplicate" };

		await expect(assessment.createDraft(input)).rejects.toEqual(
			new AssessmentError(
				"INVALID_DRAFT",
				'questions[0].options must use unique ids; "option_a" repeats.',
			),
		);
	});

	it.each<DraftCheckInput["questions"][number]>([
		{
			id: "single",
			type: "single_choice",
			prompt: "Pick one.",
			points: 1,
			options: [{ id: "a", text: "A" }],
			correctOptionId: "a",
		},
		{
			id: "multiple",
			type: "multiple_choice",
			prompt: "Pick all.",
			points: 1,
			options: [{ id: "a", text: "A" }],
			correctOptionIds: ["a"],
		},
	])("requires at least two options for $type questions", async (question) => {
		const assessment = createTestAssessment();

		await expect(assessment.createDraft(validDraft({ questions: [question] }))).rejects.toEqual(
			new AssessmentError(
				"INVALID_DRAFT",
				"questions[0].options must contain at least two options.",
			),
		);
	});

	it.each([
		{
			option: { id: " ", text: "A" },
			expected: "questions[0].options[0].id must not be blank.",
		},
		{
			option: { id: "a", text: " \n " },
			expected: "questions[0].options[0].text must not be blank.",
		},
	])(
		"rejects a choice option with invalid authored text: $expected",
		async ({ option, expected }) => {
			const assessment = createTestAssessment();

			await expect(
				assessment.createDraft(
					validDraft({
						questions: [
							{
								id: "single",
								type: "single_choice",
								prompt: "Pick one.",
								points: 1,
								options: [option, { id: "b", text: "B" }],
								correctOptionId: option.id,
							},
						],
					}),
				),
			).rejects.toEqual(new AssessmentError("INVALID_DRAFT", expected));
		},
	);

	it("replaces an editable draft while preserving its identity", async () => {
		const storage = createInMemoryAssessmentStorage();
		let now = "2026-07-26T15:00:00.000Z";
		const assessment = createAssessment({
			storage,
			clock: { now: () => now },
			ids: { next: () => "check_1" },
			hash: { digest: async (value) => `digest:${value}` },
		});
		await assessment.createDraft(validDraft());
		now = "2026-07-26T16:00:00.000Z";

		const updated = await assessment.updateDraft(
			"check_1",
			validDraft({ title: "Revised safety fundamentals", passingScore: 80 }),
		);

		expect(updated).toEqual({
			checkId: "check_1",
			courseId: "course_safety",
			title: "Revised safety fundamentals",
			description: "Confirm the key ideas.",
			passingScore: 80,
			questions: validDraft().questions,
			createdAt: "2026-07-26T15:00:00.000Z",
			updatedAt: "2026-07-26T16:00:00.000Z",
		});
	});

	it("lists every draft in deterministic recently-updated order", async () => {
		const ids = ["check_1", "check_2", "check_3"];
		let now = "2026-07-26T15:00:00.000Z";
		const assessment = createAssessment({
			storage: createInMemoryAssessmentStorage(),
			clock: { now: () => now },
			ids: { next: () => ids.shift() ?? "unexpected_id" },
			hash: { digest: async (value) => `digest:${value}` },
		});
		await assessment.createDraft(validDraft({ title: "First" }));
		now = "2026-07-26T16:00:00.000Z";
		await assessment.createDraft(validDraft({ title: "Second" }));
		now = "2026-07-26T17:00:00.000Z";
		await assessment.createDraft(validDraft({ title: "Third" }));

		const drafts = await assessment.listDrafts();

		expect(drafts.map(({ checkId, title }) => ({ checkId, title }))).toEqual([
			{ checkId: "check_3", title: "Third" },
			{ checkId: "check_2", title: "Second" },
			{ checkId: "check_1", title: "First" },
		]);
	});

	it("does not reveal whether an unpublished check is a draft or is missing", async () => {
		const assessment = createTestAssessment();
		await assessment.createDraft(validDraft());

		const draftPresentation = await assessment.present({
			courseId: "course_safety",
			checkId: "check_1",
		});
		const missingPresentation = await assessment.present({
			courseId: "course_safety",
			checkId: "check_missing",
		});

		expect({ draftPresentation, missingPresentation }).toEqual({
			draftPresentation: null,
			missingPresentation: null,
		});
	});

	it("publishes a revision and presents only explicitly public fields", async () => {
		const assessment = createTestAssessment();
		await assessment.createDraft(validDraft());

		const published = await assessment.publish("check_1");
		const presented = await assessment.present({
			courseId: "course_safety",
			checkId: "check_1",
		});

		const expected = {
			courseId: "course_safety",
			checkId: "check_1",
			revisionId: "revision_1",
			title: "Safety fundamentals",
			description: "Confirm the key ideas.",
			passingScore: 70,
			questions: [
				{
					id: "question_1",
					type: "single_choice",
					prompt: "Which action is safest?",
					points: 2,
					options: [
						{ id: "option_a", text: "Inspect first" },
						{ id: "option_b", text: "Guess" },
					],
				},
			],
		};
		expect({ published, presented }).toEqual({ published: expected, presented: expected });
	});

	it("does not present or grade a revision through a different course", async () => {
		const assessment = createTestAssessment();
		await assessment.createDraft(validDraft());
		await assessment.publish("check_1");
		const hidden = new AssessmentError("NOT_FOUND", "Knowledge Check revision was not found.");

		await expect(
			assessment.present({ courseId: "course_other", checkId: "check_1" }),
		).resolves.toBeNull();
		await expect(
			assessment.selfGrade({
				courseId: "course_other",
				checkId: "check_1",
				revisionId: "revision_1",
				answers: [{ questionId: "question_1", answer: "option_a" }],
			}),
		).rejects.toEqual(hidden);
		await expect(
			assessment.submitAttempt(
				{ kind: "verified", learnerId: "core-user-42" },
				{
					courseId: "course_other",
					checkId: "check_1",
					revisionId: "revision_1",
					submissionId: "submission_1",
					answers: [{ questionId: "question_1", answer: "option_a" }],
				},
			),
		).rejects.toEqual(hidden);
	});

	it("keeps a published revision unchanged when its draft is edited and deleted", async () => {
		const assessment = createTestAssessment();
		await assessment.createDraft(validDraft());
		const originallyPublished = await assessment.publish("check_1");

		await assessment.updateDraft(
			"check_1",
			validDraft({ title: "A future revision", passingScore: 90 }),
		);
		await assessment.deleteDraft("check_1");

		expect({
			draft: await assessment.getDraft("check_1"),
			published: await assessment.present({
				courseId: "course_safety",
				checkId: "check_1",
			}),
		}).toEqual({
			draft: null,
			published: originallyPublished,
		});
	});

	it("archives only the published head while retaining revisions and Attempts", async () => {
		const ids = ["check_1", "revision_1", "attempt_1", "revision_2"];
		const assessment = createAssessment({
			storage: createInMemoryAssessmentStorage(),
			clock: { now: () => "2026-07-26T15:00:00.000Z" },
			ids: { next: () => ids.shift() ?? "unexpected_id" },
			hash: { digest: async (value) => `digest:${value}` },
		});
		const learner: VerifiedLearner = { kind: "verified", learnerId: "core-user-42" };
		await assessment.createDraft(validDraft());
		await assessment.publish("check_1");
		await assessment.submitAttempt(learner, {
			courseId: "course_safety",
			submissionId: "submission_1",
			checkId: "check_1",
			revisionId: "revision_1",
			answers: [{ questionId: "question_1", answer: "option_a" }],
		});

		const archived = await assessment.archive("check_1");
		const archivedAgain = await assessment.archive("check_1");
		const whileArchived = await assessment.present({
			courseId: "course_safety",
			checkId: "check_1",
		});
		const republished = await assessment.publish("check_1");
		const originalRevisionResult = await assessment.selfGrade({
			courseId: "course_safety",
			checkId: "check_1",
			revisionId: "revision_1",
			answers: [{ questionId: "question_1", answer: "option_a" }],
		});
		const attempts = await assessment.listAttempts(learner, {});

		expect({
			archived,
			archivedAgain,
			whileArchived,
			republishedRevisionId: republished?.revisionId,
			originalRevisionScore: originalRevisionResult.score,
			attemptRevisionIds: attempts.map(({ revisionId }) => revisionId),
		}).toEqual({
			archived: true,
			archivedAgain: false,
			whileArchived: null,
			republishedRevisionId: "revision_2",
			originalRevisionScore: 100,
			attemptRevisionIds: ["revision_1"],
		});
	});

	it("allows an empty working draft but refuses to publish it", async () => {
		const assessment = createTestAssessment();
		await assessment.createDraft(validDraft({ questions: [] }));

		await expect(assessment.publish("check_1")).rejects.toEqual(
			new AssessmentError(
				"INVALID_DRAFT",
				"A published Knowledge Check must contain at least one question.",
			),
		);
	});

	it("self-grades the exact immutable revision deterministically", async () => {
		const ids = ["check_1", "revision_1", "revision_2"];
		const assessment = createAssessment({
			storage: createInMemoryAssessmentStorage(),
			clock: { now: () => "2026-07-26T15:00:00.000Z" },
			ids: { next: () => ids.shift() ?? "unused_id" },
			hash: { digest: async (value) => `digest:${value}` },
		});
		await assessment.createDraft(validDraft());
		await assessment.publish("check_1");
		const nextDraft = validDraft({ title: "A changed answer key" });
		const nextQuestion = nextDraft.questions[0];
		if (!nextQuestion || nextQuestion.type !== "single_choice") {
			throw new Error("Invalid test fixture");
		}
		nextQuestion.correctOptionId = "option_b";
		await assessment.updateDraft("check_1", nextDraft);
		await assessment.publish("check_1");

		const first = await assessment.selfGrade({
			courseId: "course_safety",
			checkId: "check_1",
			revisionId: "revision_1",
			answers: [{ questionId: "question_1", answer: "option_a" }],
		});
		const retry = await assessment.selfGrade({
			courseId: "course_safety",
			checkId: "check_1",
			revisionId: "revision_1",
			answers: [{ questionId: "question_1", answer: "option_a" }],
		});
		const current = await assessment.selfGrade({
			courseId: "course_safety",
			checkId: "check_1",
			revisionId: "revision_2",
			answers: [{ questionId: "question_1", answer: "option_a" }],
		});

		expect({ first, retry, current }).toEqual({
			first: {
				courseId: "course_safety",
				checkId: "check_1",
				revisionId: "revision_1",
				score: 100,
				passed: true,
				pointsAwarded: 2,
				pointsPossible: 2,
				questions: [
					{
						questionId: "question_1",
						correct: true,
						pointsAwarded: 2,
						pointsPossible: 2,
						explanation: "Inspection reduces avoidable risk.",
					},
				],
			},
			retry: {
				courseId: "course_safety",
				checkId: "check_1",
				revisionId: "revision_1",
				score: 100,
				passed: true,
				pointsAwarded: 2,
				pointsPossible: 2,
				questions: [
					{
						questionId: "question_1",
						correct: true,
						pointsAwarded: 2,
						pointsPossible: 2,
						explanation: "Inspection reduces avoidable risk.",
					},
				],
			},
			current: {
				courseId: "course_safety",
				checkId: "check_1",
				revisionId: "revision_2",
				score: 0,
				passed: false,
				pointsAwarded: 0,
				pointsPossible: 2,
				questions: [
					{
						questionId: "question_1",
						correct: false,
						pointsAwarded: 0,
						pointsPossible: 2,
						explanation: "Inspection reduces avoidable risk.",
					},
				],
			},
		});
	});

	it("grades every supported answer shape with exact-set and normalized-text semantics", async () => {
		const assessment = createTestAssessment();
		await assessment.createDraft(
			validDraft({
				passingScore: 100,
				questions: [
					{
						id: "single",
						type: "single_choice",
						prompt: "Pick one.",
						points: 1,
						options: [
							{ id: "a", text: "A" },
							{ id: "b", text: "B" },
						],
						correctOptionId: "a",
					},
					{
						id: "multiple",
						type: "multiple_choice",
						prompt: "Pick all.",
						points: 2,
						options: [
							{ id: "a", text: "A" },
							{ id: "b", text: "B" },
							{ id: "c", text: "C" },
						],
						correctOptionIds: ["a", "c"],
					},
					{
						id: "boolean",
						type: "true_false",
						prompt: "True?",
						points: 1,
						correctAnswer: true,
					},
					{
						id: "text",
						type: "short_text",
						prompt: "Protocol?",
						points: 3,
						acceptedAnswers: ["TLS", "Transport Layer Security"],
					},
				],
			}),
		);
		await assessment.publish("check_1");

		const result = await assessment.selfGrade({
			courseId: "course_safety",
			checkId: "check_1",
			revisionId: "revision_1",
			answers: [
				{ questionId: "single", answer: "a" },
				{ questionId: "multiple", answer: ["c", "a"] },
				{ questionId: "boolean", answer: true },
				{ questionId: "text", answer: "  transport layer SECURITY " },
			],
		});

		expect(result).toEqual({
			courseId: "course_safety",
			checkId: "check_1",
			revisionId: "revision_1",
			score: 100,
			passed: true,
			pointsAwarded: 7,
			pointsPossible: 7,
			questions: [
				{ questionId: "single", correct: true, pointsAwarded: 1, pointsPossible: 1 },
				{ questionId: "multiple", correct: true, pointsAwarded: 2, pointsPossible: 2 },
				{ questionId: "boolean", correct: true, pointsAwarded: 1, pointsPossible: 1 },
				{ questionId: "text", correct: true, pointsAwarded: 3, pointsPossible: 3 },
			],
		});
	});

	it("rejects an empty multiple-choice answer key", async () => {
		const assessment = createTestAssessment();
		const input = validDraft({
			questions: [
				{
					id: "multiple",
					type: "multiple_choice",
					prompt: "Pick all.",
					points: 2,
					options: [
						{ id: "a", text: "A" },
						{ id: "b", text: "B" },
					],
					correctOptionIds: [],
				},
			],
		});

		await expect(assessment.createDraft(input)).rejects.toEqual(
			new AssessmentError(
				"INVALID_DRAFT",
				"questions[0].correctOptionIds must contain at least one option id.",
			),
		);
	});

	it("rejects duplicate ids in a multiple-choice answer key", async () => {
		const assessment = createTestAssessment();

		await expect(
			assessment.createDraft(
				validDraft({
					questions: [
						{
							id: "multiple",
							type: "multiple_choice",
							prompt: "Pick all.",
							points: 2,
							options: [
								{ id: "a", text: "A" },
								{ id: "b", text: "B" },
							],
							correctOptionIds: ["a", "a"],
						},
					],
				}),
			),
		).rejects.toEqual(
			new AssessmentError(
				"INVALID_DRAFT",
				"questions[0].correctOptionIds must not contain duplicates.",
			),
		);
	});

	it("rejects a short-text question without a meaningful accepted answer", async () => {
		const assessment = createTestAssessment();
		const input = validDraft({
			questions: [
				{
					id: "text",
					type: "short_text",
					prompt: "Protocol?",
					points: 1,
					acceptedAnswers: ["  "],
				},
			],
		});

		await expect(assessment.createDraft(input)).rejects.toEqual(
			new AssessmentError(
				"INVALID_DRAFT",
				"questions[0].acceptedAnswers must contain at least one nonblank answer.",
			),
		);
	});

	it("requires a boolean answer key for true-or-false questions", async () => {
		const assessment = createTestAssessment();
		const input = validDraft({
			questions: [
				{
					id: "boolean",
					type: "true_false",
					prompt: "True?",
					points: 1,
					correctAnswer: true,
				},
			],
		});
		Reflect.set(input.questions[0] ?? {}, "correctAnswer", "true");

		await expect(assessment.createDraft(input)).rejects.toEqual(
			new AssessmentError("INVALID_DRAFT", "questions[0].correctAnswer must be a boolean."),
		);
	});

	it.each([
		{
			acceptedAnswers: ["TLS", " "],
			expected: "questions[0].acceptedAnswers must not contain blank answers.",
		},
		{
			acceptedAnswers: ["TLS", " tls "],
			expected:
				"questions[0].acceptedAnswers must be unique after trimming and case normalization.",
		},
	])(
		"rejects an invalid short-text answer set: $expected",
		async ({ acceptedAnswers, expected }) => {
			const assessment = createTestAssessment();

			await expect(
				assessment.createDraft(
					validDraft({
						questions: [
							{
								id: "text",
								type: "short_text",
								prompt: "Protocol?",
								points: 1,
								acceptedAnswers,
							},
						],
					}),
				),
			).rejects.toEqual(new AssessmentError("INVALID_DRAFT", expected));
		},
	);

	it("persists a verified Attempt and returns the original result for an identical retry", async () => {
		const storage = createInMemoryAssessmentStorage();
		const ids = ["check_1", "revision_1", "attempt_1"];
		const dependencies = {
			storage,
			clock: { now: () => "2026-07-26T15:00:00.000Z" },
			ids: { next: () => ids.shift() ?? "unexpected_id" },
			hash: { digest: async (value: string) => `digest:${value}` },
		};
		const assessment = createAssessment(dependencies);
		await assessment.createDraft(validDraft());
		await assessment.publish("check_1");
		const learner: VerifiedLearner = { kind: "verified", learnerId: "core-user-42" };
		const submission = {
			courseId: "course_safety",
			submissionId: "submission_1",
			checkId: "check_1",
			revisionId: "revision_1",
			answers: [{ questionId: "question_1", answer: "option_a" }],
		};

		const first = await assessment.submitAttempt(learner, submission);
		const afterRestart = createAssessment({
			...dependencies,
			clock: { now: () => "2026-07-27T10:00:00.000Z" },
			ids: {
				next: () => {
					throw new Error("An identical retry must not allocate another Attempt.");
				},
			},
		});
		const retry = await afterRestart.submitAttempt(learner, submission);

		const expected = {
			courseId: "course_safety",
			attemptId: "attempt_1",
			submissionId: "submission_1",
			submittedAt: "2026-07-26T15:00:00.000Z",
			checkId: "check_1",
			revisionId: "revision_1",
			score: 100,
			passed: true,
			pointsAwarded: 2,
			pointsPossible: 2,
			questions: [
				{
					questionId: "question_1",
					correct: true,
					pointsAwarded: 2,
					pointsPossible: 2,
				},
			],
		};
		expect({ first, retry }).toEqual({
			first: { ...expected, newlyRecorded: true },
			retry: { ...expected, newlyRecorded: false },
		});
		expect(
			JSON.stringify(await storage.listAttempts('digest:["learner","core-user-42"]')),
		).not.toContain("explanation");
	});

	it("resolves concurrent submission-id races without overwriting the durable winner", async () => {
		const backing = createInMemoryAssessmentStorage();
		let initialReads = 0;
		let releaseInitialReads: (() => void) | undefined;
		const bothInitialReads = new Promise<void>((resolve) => {
			releaseInitialReads = resolve;
		});
		const storage = {
			...backing,
			async getAttempt(learnerKey: string, submissionId: string) {
				const snapshot = await backing.getAttempt(learnerKey, submissionId);
				initialReads += 1;
				if (initialReads <= 2) {
					if (initialReads === 2) releaseInitialReads?.();
					await bothInitialReads;
				}
				return snapshot;
			},
		};
		const ids = ["check_1", "revision_1", "attempt_a", "attempt_b"];
		const assessment = createAssessment({
			storage,
			clock: { now: () => "2026-07-26T15:00:00.000Z" },
			ids: { next: () => ids.shift() ?? "unexpected_id" },
			hash: { digest: async (value) => `digest:${value}` },
		});
		await assessment.createDraft(validDraft());
		await assessment.publish("check_1");
		const learner: VerifiedLearner = { kind: "verified", learnerId: "core-user-42" };
		const base = {
			courseId: "course_safety",
			submissionId: "submission_1",
			checkId: "check_1",
			revisionId: "revision_1",
		};

		const settled = await Promise.allSettled([
			assessment.submitAttempt(learner, {
				...base,
				answers: [{ questionId: "question_1", answer: "option_a" }],
			}),
			assessment.submitAttempt(learner, {
				...base,
				answers: [{ questionId: "question_1", answer: "option_b" }],
			}),
		]);

		expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
		expect(settled.filter(({ status }) => status === "rejected")).toEqual([
			expect.objectContaining({
				reason: new AssessmentError(
					"SUBMISSION_CONFLICT",
					"This submission id was already used for different answers.",
				),
			}),
		]);
		expect(await backing.listAttempts('digest:["learner","core-user-42"]')).toHaveLength(1);
	});

	it("lists only the Attempts belonging to the supplied Verified Learner", async () => {
		const ids = ["check_1", "revision_1", "attempt_alice", "attempt_bob"];
		const assessment = createAssessment({
			storage: createInMemoryAssessmentStorage(),
			clock: { now: () => "2026-07-26T15:00:00.000Z" },
			ids: { next: () => ids.shift() ?? "unexpected_id" },
			hash: { digest: async (value) => `digest:${value}` },
		});
		await assessment.createDraft(validDraft());
		await assessment.publish("check_1");
		const alice: VerifiedLearner = { kind: "verified", learnerId: "alice" };
		const bob: VerifiedLearner = { kind: "verified", learnerId: "bob" };
		await assessment.submitAttempt(alice, {
			courseId: "course_safety",
			submissionId: "shared_submission",
			checkId: "check_1",
			revisionId: "revision_1",
			answers: [{ questionId: "question_1", answer: "option_a" }],
		});
		await assessment.submitAttempt(bob, {
			courseId: "course_safety",
			submissionId: "shared_submission",
			checkId: "check_1",
			revisionId: "revision_1",
			answers: [{ questionId: "question_1", answer: "option_b" }],
		});

		const aliceAttempts = await assessment.listAttempts(alice, {});
		const bobAttempts = await assessment.listAttempts(bob, {});
		const aliceFilteredOut = await assessment.listAttempts(alice, {
			checkId: "check_other",
		});

		expect({
			alice: aliceAttempts.map(({ attemptId, score }) => ({ attemptId, score })),
			bob: bobAttempts.map(({ attemptId, score }) => ({ attemptId, score })),
			aliceFilteredOut,
		}).toEqual({
			alice: [{ attemptId: "attempt_alice", score: 100 }],
			bob: [{ attemptId: "attempt_bob", score: 0 }],
			aliceFilteredOut: [],
		});
	});

	it("erases only the supplied Verified Learner's Attempts", async () => {
		const ids = ["check_1", "revision_1", "attempt_alice", "attempt_bob"];
		const assessment = createAssessment({
			storage: createInMemoryAssessmentStorage(),
			clock: { now: () => "2026-07-26T15:00:00.000Z" },
			ids: { next: () => ids.shift() ?? "unexpected_id" },
			hash: { digest: async (value) => `digest:${value}` },
		});
		await assessment.createDraft(validDraft());
		await assessment.publish("check_1");
		const alice: VerifiedLearner = { kind: "verified", learnerId: "alice" };
		const bob: VerifiedLearner = { kind: "verified", learnerId: "bob" };
		await assessment.submitAttempt(alice, {
			courseId: "course_safety",
			submissionId: "shared_submission",
			checkId: "check_1",
			revisionId: "revision_1",
			answers: [{ questionId: "question_1", answer: "option_a" }],
		});
		await assessment.submitAttempt(bob, {
			courseId: "course_safety",
			submissionId: "shared_submission",
			checkId: "check_1",
			revisionId: "revision_1",
			answers: [{ questionId: "question_1", answer: "option_b" }],
		});

		const erased = await assessment.eraseLearnerAttempts(alice);

		expect({
			erased,
			alice: await assessment.listAttempts(alice, {}),
			bob: (await assessment.listAttempts(bob, {})).map(({ attemptId }) => attemptId),
		}).toEqual({
			erased: 1,
			alice: [],
			bob: ["attempt_bob"],
		});
	});

	it("rejects conflicting reuse of a learner submission id", async () => {
		const assessment = createTestAssessment();
		await assessment.createDraft(validDraft());
		await assessment.publish("check_1");
		const learner: VerifiedLearner = { kind: "verified", learnerId: "core-user-42" };
		await assessment.submitAttempt(learner, {
			courseId: "course_safety",
			submissionId: "submission_1",
			checkId: "check_1",
			revisionId: "revision_1",
			answers: [{ questionId: "question_1", answer: "option_a" }],
		});

		await expect(
			assessment.submitAttempt(learner, {
				courseId: "course_safety",
				submissionId: "submission_1",
				checkId: "check_1",
				revisionId: "revision_1",
				answers: [{ questionId: "question_1", answer: "option_b" }],
			}),
		).rejects.toEqual(
			new AssessmentError(
				"SUBMISSION_CONFLICT",
				"This submission id was already used for different answers.",
			),
		);
	});

	it("requires a nonblank submission id before persisting an Attempt", async () => {
		const assessment = createTestAssessment();
		await assessment.createDraft(validDraft());
		await assessment.publish("check_1");

		await expect(
			assessment.submitAttempt(
				{ kind: "verified", learnerId: "core-user-42" },
				{
					courseId: "course_safety",
					submissionId: " ",
					checkId: "check_1",
					revisionId: "revision_1",
					answers: [],
				},
			),
		).rejects.toEqual(new AssessmentError("INVALID_SUBMISSION", "submissionId must not be blank."));
	});

	it("self-grades without performing any personalized write", async () => {
		const backing = createInMemoryAssessmentStorage();
		let writesAllowed = true;
		const rejectUnexpectedWrite = () => {
			if (!writesAllowed) throw new Error("Self-checks must remain write-free.");
		};
		const assessment = createAssessment({
			storage: {
				...backing,
				putDraft: async (draft) => {
					rejectUnexpectedWrite();
					await backing.putDraft(draft);
				},
				deleteDraft: async (checkId) => {
					rejectUnexpectedWrite();
					await backing.deleteDraft(checkId);
				},
				createRevision: async (revision) => {
					rejectUnexpectedWrite();
					await backing.createRevision(revision);
				},
				setHead: async (checkId, revisionId) => {
					rejectUnexpectedWrite();
					await backing.setHead(checkId, revisionId);
				},
				archiveHead: async (checkId) => {
					rejectUnexpectedWrite();
					return backing.archiveHead(checkId);
				},
				putAttempt: async (attemptKey, attempt) => {
					rejectUnexpectedWrite();
					await backing.putAttempt(attemptKey, attempt);
				},
				eraseLearnerAttempts: async (learnerKey) => {
					rejectUnexpectedWrite();
					return backing.eraseLearnerAttempts(learnerKey);
				},
			},
			clock: { now: () => "2026-07-26T15:00:00.000Z" },
			ids: {
				next: (() => {
					const ids = ["check_1", "revision_1"];
					return () => ids.shift() ?? "unexpected_id";
				})(),
			},
			hash: { digest: async (value) => `digest:${value}` },
		});
		await assessment.createDraft(validDraft());
		await assessment.publish("check_1");
		writesAllowed = false;

		const result = await assessment.selfGrade({
			courseId: "course_safety",
			checkId: "check_1",
			revisionId: "revision_1",
			answers: [{ questionId: "question_1", answer: "option_a" }],
		});

		expect(result.score).toBe(100);
	});

	it("uses the same public error for draft, missing, and mismatched revisions", async () => {
		const assessment = createTestAssessment();
		await assessment.createDraft(validDraft());
		const hidden = new AssessmentError("NOT_FOUND", "Knowledge Check revision was not found.");

		await expect(
			assessment.selfGrade({
				courseId: "course_safety",
				checkId: "check_1",
				revisionId: "revision_missing",
				answers: [],
			}),
		).rejects.toEqual(hidden);
		await expect(
			assessment.selfGrade({
				courseId: "course_safety",
				checkId: "check_missing",
				revisionId: "revision_missing",
				answers: [],
			}),
		).rejects.toEqual(hidden);
		await assessment.publish("check_1");
		await expect(
			assessment.selfGrade({
				courseId: "course_safety",
				checkId: "check_other",
				revisionId: "revision_1",
				answers: [],
			}),
		).rejects.toEqual(hidden);
	});

	it.each([
		{
			answers: [
				{ questionId: "question_1", answer: "option_a" },
				{ questionId: "question_1", answer: "option_b" },
			],
			expected: 'answers must use unique question ids; "question_1" repeats.',
		},
		{
			answers: [{ questionId: "question_missing", answer: "option_a" }],
			expected: 'answers[0].questionId "question_missing" is not part of this revision.',
		},
	])("rejects a structurally invalid submission: $expected", async ({ answers, expected }) => {
		const assessment = createTestAssessment();
		await assessment.createDraft(validDraft());
		await assessment.publish("check_1");

		await expect(
			assessment.selfGrade({
				courseId: "course_safety",
				checkId: "check_1",
				revisionId: "revision_1",
				answers,
			}),
		).rejects.toEqual(new AssessmentError("INVALID_SUBMISSION", expected));
	});
});

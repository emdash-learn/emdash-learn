import { z } from "astro/zod";

import type {
	CheckSubmission,
	DraftCheckInput,
	DraftQuestion,
	IdempotentCheckSubmission,
	SubmittedAnswer,
} from "./index.js";

export const assessmentIdSchema = z.string().trim().min(1).max(200);

const choiceOptionSchema = z
	.object({
		id: assessmentIdSchema,
		text: z.string().trim().min(1).max(1000),
	})
	.strict();

const questionBase = {
	id: assessmentIdSchema,
	prompt: z.string().trim().min(1).max(4000),
	points: z.number().int().min(1).max(10_000),
	explanation: z.string().max(8000).optional(),
};

export const draftQuestionSchema: z.ZodType<DraftQuestion> = z.discriminatedUnion("type", [
	z
		.object({
			...questionBase,
			type: z.literal("single_choice"),
			options: z.array(choiceOptionSchema).min(2).max(100),
			correctOptionId: assessmentIdSchema,
		})
		.strict(),
	z
		.object({
			...questionBase,
			type: z.literal("multiple_choice"),
			options: z.array(choiceOptionSchema).min(2).max(100),
			correctOptionIds: z.array(assessmentIdSchema).min(1).max(100),
		})
		.strict(),
	z
		.object({
			...questionBase,
			type: z.literal("true_false"),
			correctAnswer: z.boolean(),
		})
		.strict(),
	z
		.object({
			...questionBase,
			type: z.literal("short_text"),
			acceptedAnswers: z.array(z.string().trim().min(1).max(1000)).min(1).max(100),
		})
		.strict(),
]);

export const draftCheckInputSchema: z.ZodType<DraftCheckInput> = z
	.object({
		courseId: assessmentIdSchema,
		title: z.string().trim().min(1).max(200),
		description: z.string().max(4000).optional(),
		passingScore: z.number().int().min(0).max(100),
		questions: z.array(draftQuestionSchema).max(200),
	})
	.strict();

export const submittedAnswerSchema: z.ZodType<SubmittedAnswer> = z
	.object({
		questionId: assessmentIdSchema,
		answer: z.union([z.string().max(4000), z.array(assessmentIdSchema).max(100), z.boolean()]),
	})
	.strict();

export const checkSubmissionSchema: z.ZodType<CheckSubmission> = z
	.object({
		courseId: assessmentIdSchema,
		checkId: assessmentIdSchema,
		revisionId: assessmentIdSchema,
		answers: z.array(submittedAnswerSchema).max(200),
	})
	.strict();

export const idempotentCheckSubmissionSchema: z.ZodType<IdempotentCheckSubmission> = z
	.object({
		courseId: assessmentIdSchema,
		checkId: assessmentIdSchema,
		revisionId: assessmentIdSchema,
		submissionId: assessmentIdSchema,
		answers: z.array(submittedAnswerSchema).max(200),
	})
	.strict();

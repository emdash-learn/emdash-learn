/**
 * Quiz routes (T08 / §6.1 student + §6.3 instructor).
 *
 * Six POST endpoints, all in one file per the Wave 3 ownership rule:
 *
 *   Student (role>=SUBSCRIBER):
 *     - quiz:start   { quizId, lessonId? }     → { attemptId, questions, startedAt, timeLimit? }
 *     - quiz:submit  { attemptId, answers }    → { score, passed, feedback, overtime }
 *       (owner scope enforced by looking up attempt.userId)
 *
 *   Instructor (EDITOR):
 *     - quiz:create  / quiz:update / quiz:list / quiz:delete
 *
 * Time-limit enforcement: the engine's `submitAttempt` refuses a submission
 * past the hard limit with `LEARN_QUIZ_TIMEOUT`; soft policy lets the grade
 * through with `overtime=true`. Routes only translate Result codes to HTTP.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute } from "emdash";

import { type AuthContext, Role, requireOwner, requireRole } from "../authz.js";
import { LEARN_ERRORS } from "../constants.js";
import * as quizzes from "../engine/quizzes.js";
import type { Result, ResultError } from "../engine/result.js";

// ---------------------------------------------------------------------------
// Zod schemas (§23)
// ---------------------------------------------------------------------------

const quizQuestionOption = z.object({
	id: z.string().min(1),
	text: z.string().min(1),
	correct: z.boolean(),
});

const quizQuestionSchema = z.object({
	id: z.string().min(1),
	type: z.enum(["mcq", "multi", "true_false", "short_text"]),
	prompt: z.string().min(1),
	options: z.array(quizQuestionOption).optional(),
	explanation: z.string().optional(),
	points: z.number().int().min(0).default(1),
});

export const quizCreateInput = z.object({
	title: z.string().min(1).max(200),
	description: z.string().max(1000).optional(),
	passingScore: z.number().int().min(0).max(100),
	timeLimit: z.number().int().min(1).optional(),
	timeLimitPolicy: z.enum(["hard", "soft"]).default("hard"),
	randomize: z.boolean().default(false),
	questions: z.array(quizQuestionSchema).min(1),
});
export type QuizCreateInput = z.infer<typeof quizCreateInput>;

export const quizUpdateInput = z.object({
	quizId: z.string().min(1),
	title: z.string().min(1).max(200).optional(),
	description: z.string().max(1000).optional(),
	passingScore: z.number().int().min(0).max(100).optional(),
	timeLimit: z.number().int().min(1).optional(),
	timeLimitPolicy: z.enum(["hard", "soft"]).optional(),
	randomize: z.boolean().optional(),
	questions: z.array(quizQuestionSchema).min(1).optional(),
});
export type QuizUpdateInput = z.infer<typeof quizUpdateInput>;

export const quizDeleteInput = z.object({ quizId: z.string().min(1) });
export type QuizDeleteInput = z.infer<typeof quizDeleteInput>;

export const quizListInput = z.object({
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(100).optional(),
});
export type QuizListInput = z.infer<typeof quizListInput>;

export const quizStartInput = z.object({
	quizId: z.string().min(1),
	lessonId: z.string().optional(),
});
export type QuizStartInput = z.infer<typeof quizStartInput>;

export const quizSubmitInput = z.object({
	attemptId: z.string().min(1),
	answers: z
		.array(
			z.object({
				questionId: z.string().min(1),
				answer: z.union([z.string(), z.array(z.string()), z.boolean()]),
			}),
		)
		.min(1),
});
export type QuizSubmitInput = z.infer<typeof quizSubmitInput>;

// ---------------------------------------------------------------------------
// Error → HTTP mapping
// ---------------------------------------------------------------------------

function statusForCode(code: string): number {
	switch (code) {
		case LEARN_ERRORS.UNAUTHENTICATED:
			return 401;
		case LEARN_ERRORS.FORBIDDEN:
		case LEARN_ERRORS.NOT_INSTRUCTOR:
			return 403;
		case LEARN_ERRORS.QUIZ_NOT_STARTED:
			return 404;
		case LEARN_ERRORS.QUIZ_TIMEOUT:
		case LEARN_ERRORS.SETUP_INCOMPLETE:
			return 409;
		default:
			return 400;
	}
}

function toRouteError(error: ResultError): PluginRouteError {
	return new PluginRouteError(error.code, error.message, statusForCode(error.code));
}

function unwrap<T>(result: Result<T>): T {
	if (!result.ok) throw toRouteError(result.error);
	return result.data;
}

function gateInstructor(ctx: unknown): void {
	const auth = ctx as AuthContext;
	const user = requireRole(auth, Role.EDITOR);
	if (!user.ok) throw toRouteError(user.error);
}

function gateStudent(ctx: unknown): { id: string } {
	const auth = ctx as AuthContext;
	const user = requireRole(auth, Role.SUBSCRIBER);
	if (!user.ok) throw toRouteError(user.error);
	return { id: user.data.id };
}

// ---------------------------------------------------------------------------
// Student routes
// ---------------------------------------------------------------------------

const startRoute: PluginRoute<QuizStartInput> = {
	input: quizStartInput,
	handler: async (ctx) => {
		const user = gateStudent(ctx);
		const result = unwrap(
			await quizzes.startAttempt(ctx, user.id, ctx.input.quizId, ctx.input.lessonId),
		);
		return result;
	},
};

const submitRoute: PluginRoute<QuizSubmitInput> = {
	input: quizSubmitInput,
	handler: async (ctx) => {
		const user = gateStudent(ctx);

		// Owner scope: load attempt, verify caller owns it.
		const attempts = ctx.storage["quiz_attempts"];
		if (!attempts) {
			throw new PluginRouteError(
				LEARN_ERRORS.SETUP_INCOMPLETE,
				"quiz_attempts storage missing",
				409,
			);
		}
		const row = await attempts.get(ctx.input.attemptId);
		if (!row) {
			throw new PluginRouteError(
				LEARN_ERRORS.QUIZ_NOT_STARTED,
				`Attempt ${ctx.input.attemptId} not found`,
				404,
			);
		}
		const owned = requireOwner(ctx, user.id, row as { userId: string });
		if (!owned.ok) throw toRouteError(owned.error);

		const result = unwrap(
			await quizzes.submitAttempt(ctx, ctx.input.attemptId, ctx.input.answers),
		);
		return result;
	},
};

// ---------------------------------------------------------------------------
// Instructor routes
// ---------------------------------------------------------------------------

const createRoute: PluginRoute<QuizCreateInput> = {
	input: quizCreateInput,
	handler: async (ctx) => {
		gateInstructor(ctx);
		const record = unwrap(await quizzes.create(ctx, ctx.input));
		return { id: record.id, quiz: record.data };
	},
};

const updateRoute: PluginRoute<QuizUpdateInput> = {
	input: quizUpdateInput,
	handler: async (ctx) => {
		gateInstructor(ctx);
		const { quizId, ...patch } = ctx.input;
		const record = unwrap(await quizzes.update(ctx, quizId, patch));
		return { id: record.id, quiz: record.data };
	},
};

const listRoute: PluginRoute<QuizListInput> = {
	input: quizListInput,
	handler: async (ctx) => {
		gateInstructor(ctx);
		const opts: quizzes.ListOptions = {};
		if (ctx.input.cursor !== undefined) opts.cursor = ctx.input.cursor;
		if (ctx.input.limit !== undefined) opts.limit = ctx.input.limit;
		const page = unwrap(await quizzes.list(ctx, opts));
		return {
			items: page.items.map((r) => ({ id: r.id, ...r.data })),
			cursor: page.cursor,
			hasMore: page.hasMore,
		};
	},
};

const deleteRoute: PluginRoute<QuizDeleteInput> = {
	input: quizDeleteInput,
	handler: async (ctx) => {
		gateInstructor(ctx);
		unwrap(await quizzes.remove(ctx, ctx.input.quizId));
		return { ok: true };
	},
};

export const quizRoutes = {
	"quiz:start": startRoute,
	"quiz:submit": submitRoute,
	"quiz:create": createRoute,
	"quiz:update": updateRoute,
	"quiz:list": listRoute,
	"quiz:delete": deleteRoute,
} as const;

export type {
	QuestionForStudent,
	QuestionFeedback,
	StartAttemptResult,
	SubmitAttemptResult,
} from "../engine/quizzes.js";

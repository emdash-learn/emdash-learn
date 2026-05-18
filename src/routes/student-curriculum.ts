/**
 * Student curriculum routes (T07 / §6.1).
 *
 *   curriculum    { courseId } → { items: VisibleLesson[] }
 *   lesson        { lessonId } → { lesson: ContentItem } with gating enforced
 *   my-learning   { status?, cursor?, limit? } → paginated my-learning items
 *
 * All three gate on `role>=SUBSCRIBER`. Engine applies drip + requires_previous
 * + is_preview; routes only do authz + error-mapping.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute, type RouteContext } from "emdash";

import { Role, requireRole } from "../authz.js";
import { LEARN_ERRORS } from "../constants.js";
import * as curriculum from "../engine/curriculum.js";
import type { Result, ResultError } from "../engine/result.js";
import { ensureSetupComplete } from "../setup-gate.js";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const curriculumInput = z.object({ courseId: z.string().min(1) });
export type CurriculumInput = z.infer<typeof curriculumInput>;

export const lessonInput = z.object({ lessonId: z.string().min(1) });
export type LessonInput = z.infer<typeof lessonInput>;

export const topicInput = z.object({ topicId: z.string().min(1) });
export type TopicInput = z.infer<typeof topicInput>;

export const myLearningInput = z.object({
	status: z.enum(["active", "completed", "all"]).optional(),
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(100).optional(),
});
export type MyLearningInput = z.infer<typeof myLearningInput>;

// ---------------------------------------------------------------------------
// Error → HTTP
// ---------------------------------------------------------------------------

function statusForCode(code: string): number {
	switch (code) {
		case LEARN_ERRORS.UNAUTHENTICATED:
			return 401;
		case LEARN_ERRORS.FORBIDDEN:
		case LEARN_ERRORS.NOT_ENROLLED:
		case LEARN_ERRORS.LESSON_LOCKED:
		case LEARN_ERRORS.TOPIC_LOCKED:
			return 403;
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

function gateStudent(ctx: RouteContext): { id: string } {
	const user = requireRole(ctx, Role.SUBSCRIBER);
	if (!user.ok) throw toRouteError(user.error);
	return { id: user.data.id };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const curriculumRoute: PluginRoute<CurriculumInput> = {
	input: curriculumInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const user = gateStudent(ctx);
		const items = unwrap(await curriculum.forUser(ctx, user.id, ctx.input.courseId));
		return { items };
	},
};

const lessonRoute: PluginRoute<LessonInput> = {
	input: lessonInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const user = gateStudent(ctx);
		const item = unwrap(await curriculum.getLesson(ctx, user.id, ctx.input.lessonId));
		return { lesson: item };
	},
};

const topicRoute: PluginRoute<TopicInput> = {
	input: topicInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const user = gateStudent(ctx);
		const item = unwrap(await curriculum.getTopic(ctx, user.id, ctx.input.topicId));
		return { topic: item };
	},
};

const myLearningRoute: PluginRoute<MyLearningInput> = {
	input: myLearningInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const user = gateStudent(ctx);
		const opts: curriculum.MyLearningOptions = {};
		if (ctx.input.status !== undefined) opts.status = ctx.input.status;
		if (ctx.input.cursor !== undefined) opts.cursor = ctx.input.cursor;
		if (ctx.input.limit !== undefined) opts.limit = ctx.input.limit;
		const page = unwrap(await curriculum.myLearning(ctx, user.id, opts));
		return page;
	},
};

export const curriculumRoutes = {
	curriculum: curriculumRoute,
	lesson: lessonRoute,
	topic: topicRoute,
	"my-learning": myLearningRoute,
} as const;

export type {
	MyLearningItem,
	MyLearningPage,
	VisibleLesson,
	VisibleTopic,
} from "../engine/curriculum.js";

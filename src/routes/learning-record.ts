import { z } from "astro/zod";
import { PluginRouteError, type PluginContext, type PluginRoute, type RouteContext } from "emdash";

import type { EngagementReporting } from "../modules/engagement-reporting/index.js";
import { requireVerifiedLearner } from "../modules/learner-principal.js";
import { LearningRecordError, type LearningRecord } from "../modules/learning-record/index.js";
import { learnerPrincipalFromRoute } from "./route-principal.js";

const boundedId = z.string().trim().min(1).max(200);
const operationId = z.string().uuid();

export const completeLessonInput = z
	.object({
		lessonId: boundedId,
		operationId,
	})
	.strict();

export const courseProgressInput = z
	.object({
		courseId: boundedId,
	})
	.strict();

export const importDeviceProgressInput = z
	.object({
		courseId: boundedId,
		lessonIds: z.array(boundedId).max(1000),
		operationId,
	})
	.strict();

type CompleteLessonInput = z.infer<typeof completeLessonInput>;
type CourseProgressInput = z.infer<typeof courseProgressInput>;
type ImportDeviceProgressInput = z.infer<typeof importDeviceProgressInput>;

export interface LearningRecordRouteServices {
	createLearningRecord(ctx: PluginContext): LearningRecord | Promise<LearningRecord>;
	createReporting(ctx: PluginContext): EngagementReporting | Promise<EngagementReporting>;
}

function requirePost(request: Request): void {
	if (request.method.toUpperCase() !== "POST") {
		throw new PluginRouteError(
			"LEARN_METHOD_NOT_ALLOWED",
			"Learning Record routes require POST.",
			405,
		);
	}
}

function toRouteError(error: unknown): never {
	if (error instanceof PluginRouteError) throw error;
	if (error instanceof LearningRecordError) {
		throw new PluginRouteError(error.code, error.message, error.status);
	}
	if (
		typeof error === "object" &&
		error !== null &&
		Reflect.get(error, "code") === "LEARN_UNAUTHENTICATED"
	) {
		throw new PluginRouteError(
			"LEARN_UNAUTHENTICATED",
			"A verified EmDash learner session is required.",
			401,
		);
	}
	throw error;
}

async function verified<TInput>(
	ctx: RouteContext<TInput>,
): Promise<ReturnType<typeof requireVerifiedLearner>> {
	try {
		requirePost(ctx.request);
		return requireVerifiedLearner(learnerPrincipalFromRoute(ctx));
	} catch (error) {
		return toRouteError(error);
	}
}

async function observeCompletions(
	ctx: RouteContext,
	services: LearningRecordRouteServices,
	input: {
		courseId: string;
		lessonIds: string[];
		learner: ReturnType<typeof requireVerifiedLearner>;
	},
): Promise<void> {
	try {
		const reporting = await services.createReporting(ctx);
		for (const lessonId of input.lessonIds) {
			// oxlint-disable-next-line no-await-in-loop -- preserve observation order and bound writes
			await reporting.observe({
				type: "lesson_completed",
				courseId: input.courseId,
				lessonId,
				actor: input.learner,
			});
		}
	} catch (error) {
		ctx.log.warn("Learn engagement observation failed after lesson completion.", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function createLearningRecordRoutes(services: LearningRecordRouteServices) {
	const complete: PluginRoute<CompleteLessonInput> & { permission: "content:read" } = {
		input: completeLessonInput,
		permission: "content:read",
		handler: async (ctx) => {
			const learner = await verified(ctx);
			try {
				const learning = await services.createLearningRecord(ctx);
				const result = await learning.completeLesson(learner, ctx.input);
				if (result.newlyCompleted) {
					await observeCompletions(ctx, services, {
						courseId: result.progress.courseId,
						lessonIds: [ctx.input.lessonId],
						learner,
					});
				}
				return result;
			} catch (error) {
				return toRouteError(error);
			}
		},
	};

	const progress: PluginRoute<CourseProgressInput> & { permission: "content:read" } = {
		input: courseProgressInput,
		permission: "content:read",
		handler: async (ctx) => {
			const learner = await verified(ctx);
			try {
				const learning = await services.createLearningRecord(ctx);
				return await learning.getCourseProgress(learner, ctx.input);
			} catch (error) {
				return toRouteError(error);
			}
		},
	};

	const importDevice: PluginRoute<ImportDeviceProgressInput> & {
		permission: "content:read";
	} = {
		input: importDeviceProgressInput,
		permission: "content:read",
		handler: async (ctx) => {
			const learner = await verified(ctx);
			try {
				const learning = await services.createLearningRecord(ctx);
				const result = await learning.importDeviceProgress(learner, ctx.input);
				if (result.importedLessonIds.length > 0) {
					await observeCompletions(ctx, services, {
						courseId: result.progress.courseId,
						lessonIds: result.importedLessonIds,
						learner,
					});
				}
				return result;
			} catch (error) {
				return toRouteError(error);
			}
		},
	};

	return {
		"learning:complete-lesson": complete,
		"learning:progress": progress,
		"learning:import-device-progress": importDevice,
	} as const;
}

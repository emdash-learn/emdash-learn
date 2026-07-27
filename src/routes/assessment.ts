import { z } from "astro/zod";
import { PluginRouteError, type PluginContext, type PluginRoute, type RouteContext } from "emdash";

import { AssessmentError, type Assessment, type CheckResult } from "../modules/assessment/index.js";
import {
	assessmentIdSchema,
	draftCheckInputSchema,
	submittedAnswerSchema,
} from "../modules/assessment/schema.js";
import type { EngagementReporting } from "../modules/engagement-reporting/index.js";
import { PublicRateLimitError } from "../security/public-rate-limit.js";

const checkIdInput = z.object({ checkId: assessmentIdSchema }).strict();
export const assessmentPresentInput = z
	.object({
		courseId: assessmentIdSchema,
		checkId: assessmentIdSchema,
	})
	.strict();
const emptyInput = z.object({}).strict();

export const assessmentSelfGradeInput = z
	.object({
		courseId: assessmentIdSchema,
		checkId: assessmentIdSchema,
		revisionId: assessmentIdSchema,
		answers: z.array(submittedAnswerSchema).max(200),
	})
	.strict();

const assessmentUpdateDraftInput = z
	.object({
		checkId: assessmentIdSchema,
		draft: draftCheckInputSchema,
	})
	.strict();

type CheckIdInput = z.infer<typeof checkIdInput>;
type PresentInput = z.infer<typeof assessmentPresentInput>;
type SelfGradeInput = z.infer<typeof assessmentSelfGradeInput>;
type UpdateDraftInput = z.infer<typeof assessmentUpdateDraftInput>;
type EmptyInput = z.infer<typeof emptyInput>;

export interface AssessmentRouteServices {
	createAssessment(ctx: PluginContext): Assessment | Promise<Assessment>;
	createReporting(ctx: PluginContext): EngagementReporting | Promise<EngagementReporting>;
	beforePublicAssessment(ctx: RouteContext): void | Promise<void>;
	requirePublishedAssessmentCourse(ctx: RouteContext, courseId: string): void | Promise<void>;
}

function requirePost(request: Request): void {
	if (request.method.toUpperCase() !== "POST") {
		throw new PluginRouteError("LEARN_METHOD_NOT_ALLOWED", "Assessment routes require POST.", 405);
	}
}

function toRouteError(error: unknown): never {
	if (error instanceof PluginRouteError) throw error;
	if (error instanceof PublicRateLimitError) {
		throw new PluginRouteError(error.code, error.message, error.status);
	}
	if (error instanceof AssessmentError) {
		const status =
			error.code === "NOT_FOUND" ? 404 : error.code === "SUBMISSION_CONFLICT" ? 409 : 400;
		throw new PluginRouteError(`LEARN_ASSESSMENT_${error.code}`, error.message, status);
	}
	throw error;
}

async function observeResult(
	ctx: RouteContext,
	services: AssessmentRouteServices,
	result: Pick<CheckResult, "courseId" | "checkId" | "passed" | "score">,
): Promise<void> {
	try {
		const reporting = await services.createReporting(ctx);
		await reporting.observe({
			type: "check_submitted",
			courseId: result.courseId,
			checkId: result.checkId,
			passed: result.passed,
			score: result.score,
		});
	} catch (error) {
		ctx.log.warn("Learn engagement observation failed after Knowledge Check grading.", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function createAssessmentRoutes(services: AssessmentRouteServices) {
	const present: PluginRoute<PresentInput> & { public: true } = {
		input: assessmentPresentInput,
		public: true,
		handler: async (ctx) => {
			requirePost(ctx.request);
			try {
				await services.beforePublicAssessment(ctx);
				await services.requirePublishedAssessmentCourse(ctx, ctx.input.courseId);
				const assessment = await services.createAssessment(ctx);
				const presentation = await assessment.present({
					courseId: ctx.input.courseId,
					checkId: ctx.input.checkId,
				});
				if (presentation) return presentation;
				throw new PluginRouteError(
					"LEARN_ASSESSMENT_NOT_FOUND",
					"Published Knowledge Check not found.",
					404,
				);
			} catch (error) {
				return toRouteError(error);
			}
		},
	};

	const selfGrade: PluginRoute<SelfGradeInput> & { public: true } = {
		input: assessmentSelfGradeInput,
		public: true,
		handler: async (ctx) => {
			requirePost(ctx.request);
			try {
				await services.beforePublicAssessment(ctx);
				await services.requirePublishedAssessmentCourse(ctx, ctx.input.courseId);
				const assessment = await services.createAssessment(ctx);
				const result = await assessment.selfGrade({
					courseId: ctx.input.courseId,
					checkId: ctx.input.checkId,
					revisionId: ctx.input.revisionId,
					answers: ctx.input.answers,
				});
				await observeResult(ctx, services, result);
				return result;
			} catch (error) {
				return toRouteError(error);
			}
		},
	};

	const draftList: PluginRoute<EmptyInput> & { permission: "content:edit_any" } = {
		input: emptyInput,
		permission: "content:edit_any",
		handler: async (ctx) => {
			requirePost(ctx.request);
			const assessment = await services.createAssessment(ctx);
			return { items: await assessment.listDrafts() };
		},
	};

	const draftCreate: PluginRoute<z.infer<typeof draftCheckInputSchema>> & {
		permission: "content:edit_any";
	} = {
		input: draftCheckInputSchema,
		permission: "content:edit_any",
		handler: async (ctx) => {
			requirePost(ctx.request);
			try {
				const assessment = await services.createAssessment(ctx);
				return await assessment.createDraft(ctx.input);
			} catch (error) {
				return toRouteError(error);
			}
		},
	};

	const draftGet: PluginRoute<CheckIdInput> & { permission: "content:edit_any" } = {
		input: checkIdInput,
		permission: "content:edit_any",
		handler: async (ctx) => {
			requirePost(ctx.request);
			const assessment = await services.createAssessment(ctx);
			const draft = await assessment.getDraft(ctx.input.checkId);
			if (draft) return draft;
			throw new PluginRouteError("LEARN_ASSESSMENT_NOT_FOUND", "Draft not found.", 404);
		},
	};

	const draftUpdate: PluginRoute<UpdateDraftInput> & {
		permission: "content:edit_any";
	} = {
		input: assessmentUpdateDraftInput,
		permission: "content:edit_any",
		handler: async (ctx) => {
			requirePost(ctx.request);
			try {
				const assessment = await services.createAssessment(ctx);
				const draft = await assessment.updateDraft(ctx.input.checkId, ctx.input.draft);
				if (draft) return draft;
				throw new PluginRouteError("LEARN_ASSESSMENT_NOT_FOUND", "Draft not found.", 404);
			} catch (error) {
				return toRouteError(error);
			}
		},
	};

	const draftDelete: PluginRoute<CheckIdInput> & { permission: "content:edit_any" } = {
		input: checkIdInput,
		permission: "content:edit_any",
		handler: async (ctx) => {
			requirePost(ctx.request);
			const assessment = await services.createAssessment(ctx);
			await assessment.deleteDraft(ctx.input.checkId);
			return { deleted: true };
		},
	};

	const publish: PluginRoute<CheckIdInput> & { permission: "content:edit_any" } = {
		input: checkIdInput,
		permission: "content:edit_any",
		handler: async (ctx) => {
			requirePost(ctx.request);
			try {
				const assessment = await services.createAssessment(ctx);
				const presentation = await assessment.publish(ctx.input.checkId);
				if (presentation) return presentation;
				throw new PluginRouteError("LEARN_ASSESSMENT_NOT_FOUND", "Draft not found.", 404);
			} catch (error) {
				return toRouteError(error);
			}
		},
	};

	const archive: PluginRoute<CheckIdInput> & { permission: "content:edit_any" } = {
		input: checkIdInput,
		permission: "content:edit_any",
		handler: async (ctx) => {
			requirePost(ctx.request);
			const assessment = await services.createAssessment(ctx);
			return { archived: await assessment.archive(ctx.input.checkId) };
		},
	};

	return {
		"assessment:present": present,
		"assessment:self-grade": selfGrade,
		"assessment:draft-list": draftList,
		"assessment:draft-create": draftCreate,
		"assessment:draft-get": draftGet,
		"assessment:draft-update": draftUpdate,
		"assessment:draft-delete": draftDelete,
		"assessment:publish": publish,
		"assessment:archive": archive,
	} as const;
}

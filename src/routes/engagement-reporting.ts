import { z } from "astro/zod";
import { PluginRouteError, type PluginContext, type PluginRoute, type RouteContext } from "emdash";

import {
	EngagementReportingError,
	type EngagementObservation,
	type EngagementReporting,
} from "../modules/engagement-reporting/index.js";
import { PublicRateLimitError } from "../security/public-rate-limit.js";
import { learnerPrincipalFromRoute } from "./route-principal.js";

const boundedId = z.string().trim().min(1).max(200);

export const publicEngagementObservationInput = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("course_opened"),
			courseId: boundedId,
		})
		.strict(),
	z
		.object({
			type: z.literal("lesson_opened"),
			courseId: boundedId,
			lessonId: boundedId,
		})
		.strict(),
	z
		.object({
			type: z.literal("check_opened"),
			courseId: boundedId,
			checkId: boundedId,
		})
		.strict(),
]);

export const engagementReportQueryInput = z
	.object({
		from: z.string().max(100),
		to: z.string().max(100),
		courseId: boundedId.optional(),
	})
	.strict();

type PublicObservationInput = z.infer<typeof publicEngagementObservationInput>;
type EngagementReportQueryInput = z.infer<typeof engagementReportQueryInput>;

export interface EngagementReportingRouteServices {
	createReporting(ctx: PluginContext): EngagementReporting | Promise<EngagementReporting>;
	/**
	 * Abuse-control seam. Production uses a redacted, bounded limiter; tests can
	 * substitute a deterministic implementation.
	 */
	beforePublicObservation(ctx: RouteContext<PublicObservationInput>): void | Promise<void>;
}

function requirePost(request: Request): void {
	if (request.method.toUpperCase() !== "POST") {
		throw new PluginRouteError("LEARN_METHOD_NOT_ALLOWED", "Engagement routes require POST.", 405);
	}
}

function toRouteError(error: unknown): never {
	if (error instanceof PluginRouteError) throw error;
	if (error instanceof EngagementReportingError) {
		throw new PluginRouteError(error.code, error.message, error.status);
	}
	if (error instanceof PublicRateLimitError) {
		throw new PluginRouteError(error.code, error.message, error.status);
	}
	throw error;
}

function toObservation(ctx: RouteContext<PublicObservationInput>): EngagementObservation {
	const actor = learnerPrincipalFromRoute(ctx);
	switch (ctx.input.type) {
		case "course_opened":
			return {
				type: "course_opened",
				courseId: ctx.input.courseId,
				actor,
			};
		case "lesson_opened":
			return {
				type: "lesson_opened",
				courseId: ctx.input.courseId,
				lessonId: ctx.input.lessonId,
				actor,
			};
		case "check_opened":
			return {
				type: "check_opened",
				courseId: ctx.input.courseId,
				checkId: ctx.input.checkId,
				actor,
			};
		default:
			return assertNever(ctx.input);
	}
}

function assertNever(value: never): never {
	throw new Error(`Unsupported observation: ${JSON.stringify(value)}`);
}

export function createEngagementReportingRoutes(services: EngagementReportingRouteServices) {
	const observe: PluginRoute<PublicObservationInput> & { public: true } = {
		input: publicEngagementObservationInput,
		public: true,
		handler: async (ctx) => {
			requirePost(ctx.request);
			try {
				await services.beforePublicObservation(ctx);
				const reporting = await services.createReporting(ctx);
				await reporting.observe(toObservation(ctx));
				return { accepted: true };
			} catch (error) {
				return toRouteError(error);
			}
		},
	};

	const query: PluginRoute<EngagementReportQueryInput> & {
		permission: "plugins:manage";
	} = {
		input: engagementReportQueryInput,
		permission: "plugins:manage",
		handler: async (ctx) => {
			requirePost(ctx.request);
			try {
				const reporting = await services.createReporting(ctx);
				return await reporting.query(ctx.input);
			} catch (error) {
				return toRouteError(error);
			}
		},
	};

	return {
		"engagement:observe": observe,
		"reporting:query": query,
	} as const;
}

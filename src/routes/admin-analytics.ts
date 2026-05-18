/**
 * Admin analytics routes (T15 / §6.3 / §22 Phase 5).
 *
 * Three ADMIN-gated routes. Backend-only per D33 — there is no admin UI in
 * v1. The routes exist so the orchestrator can wire them and so external
 * admin tooling (scripts, the future admin app) has a stable surface.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute } from "emdash";

import { Role, requireRole } from "../authz.js";
import { LEARN_ERRORS } from "../constants.js";
import * as analytics from "../engine/analytics.js";
import type { Result, ResultError } from "../engine/result.js";
import { ensureSetupComplete } from "../setup-gate.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const dateRangeInput = z.object({
	range: z.object({
		from: z.string().datetime(),
		to: z.string().datetime(),
	}),
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(100).optional(),
});
type DateRangeInput = z.infer<typeof dateRangeInput>;

// ---------------------------------------------------------------------------
// Error → HTTP mapping
// ---------------------------------------------------------------------------

function statusForCode(code: string): number {
	if (code === LEARN_ERRORS.UNAUTHENTICATED) return 401;
	if (code === LEARN_ERRORS.FORBIDDEN) return 403;
	return 400;
}

function toRouteError(e: ResultError): PluginRouteError {
	return new PluginRouteError(e.code, e.message, statusForCode(e.code));
}

function unwrap<T>(r: Result<T>): T {
	if (!r.ok) throw toRouteError(r.error);
	return r.data;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const overviewRoute: PluginRoute<DateRangeInput> = {
	input: dateRangeInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const user = requireRole(ctx, Role.ADMIN);
		if (!user.ok) throw toRouteError(user.error);
		return unwrap(await analytics.siteAnalytics(ctx, ctx.input.range));
	},
};

const comparisonRoute: PluginRoute<DateRangeInput> = {
	input: dateRangeInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const user = requireRole(ctx, Role.ADMIN);
		if (!user.ok) throw toRouteError(user.error);
		const opts: { cursor?: string; limit?: number } = {};
		if (ctx.input.cursor !== undefined) opts.cursor = ctx.input.cursor;
		if (ctx.input.limit !== undefined) opts.limit = ctx.input.limit;
		return unwrap(await analytics.coursesComparison(ctx, ctx.input.range, opts));
	},
};

const engagementRoute: PluginRoute<DateRangeInput> = {
	input: dateRangeInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const user = requireRole(ctx, Role.ADMIN);
		if (!user.ok) throw toRouteError(user.error);
		return unwrap(await analytics.engagementMetrics(ctx, ctx.input.range));
	},
};

export type {
	CourseComparison,
	DateRange,
	EngagementMetrics,
	PaginatedResult,
	SiteAnalytics,
} from "../engine/analytics.js";

export const adminAnalyticsRoutes = {
	"admin:analytics-overview": overviewRoute,
	"admin:courses-comparison": comparisonRoute,
	"admin:engagement-metrics": engagementRoute,
} as const;

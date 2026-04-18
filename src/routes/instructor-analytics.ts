/**
 * Instructor analytics routes (T15 / §6.3 / §22 Phase 5).
 *
 * Eleven EDITOR-gated routes. Per-course routes additionally require the
 * caller to be an instructor of the target course (`requireInstructor`).
 * Backend-only per D33 — the UI is deferred to v2.
 *
 * CSV exports (`instructor:enrollments-export`, `instructor:progress-export`)
 * return `{ csv: string }` so the Astro layer can stream the bytes to the
 * client without any additional framing.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute } from "emdash";

import { type AuthContext, Role, requireInstructor, requireRole } from "../authz.js";
import { LEARN_ERRORS } from "../constants.js";
import * as analytics from "../engine/analytics.js";
import type { Result, ResultError } from "../engine/result.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const emptyInput = z.object({});

const recentActivityInput = z.object({
	limit: z.number().int().min(1).max(100).optional(),
});
type RecentActivityInput = z.infer<typeof recentActivityInput>;

const courseIdInput = z.object({ courseId: z.string().min(1) });
type CourseIdInput = z.infer<typeof courseIdInput>;

const timelineInput = z.object({
	courseId: z.string().min(1),
	days: z.number().int().min(1).max(365).optional(),
});
type TimelineInput = z.infer<typeof timelineInput>;

const progressMatrixInput = z.object({
	courseId: z.string().min(1),
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(200).optional(),
});
type ProgressMatrixInput = z.infer<typeof progressMatrixInput>;

const studentProgressInput = z.object({ studentId: z.string().min(1) });
type StudentProgressInput = z.infer<typeof studentProgressInput>;

type EmptyInput = z.infer<typeof emptyInput>;

// ---------------------------------------------------------------------------
// Error → HTTP mapping (§17.6)
// ---------------------------------------------------------------------------

function statusForCode(code: string): number {
	if (code === LEARN_ERRORS.UNAUTHENTICATED) return 401;
	if (code === LEARN_ERRORS.FORBIDDEN || code === LEARN_ERRORS.NOT_INSTRUCTOR) return 403;
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
// CSV helpers
// ---------------------------------------------------------------------------

function quoteCsv(v: string): string {
	if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
	return v;
}

function progressMatrixToCsv(matrix: {
	students: Array<{ userId: string; name: string; lessonProgress: Record<string, number> }>;
}): string {
	const lessonIds = Array.from(
		new Set(matrix.students.flatMap((s) => Object.keys(s.lessonProgress))),
	)
		// oxlint-disable-next-line no-array-sort -- local array
		.sort();
	const header = ["userId", "name", ...lessonIds].join(",");
	const rows = matrix.students.map((s) =>
		[
			quoteCsv(s.userId),
			quoteCsv(s.name),
			...lessonIds.map((l) =>
				s.lessonProgress[l] !== undefined ? String(s.lessonProgress[l]) : "",
			),
		].join(","),
	);
	return [header, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const dashboardStatsRoute: PluginRoute<EmptyInput> = {
	input: emptyInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.EDITOR);
		if (!user.ok) throw toRouteError(user.error);
		return unwrap(await analytics.dashboardStats(ctx, user.data.id));
	},
};

const dashboardCoursesRoute: PluginRoute<EmptyInput> = {
	input: emptyInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.EDITOR);
		if (!user.ok) throw toRouteError(user.error);
		return unwrap(await analytics.dashboardCourses(ctx, user.data.id));
	},
};

const recentActivityRoute: PluginRoute<RecentActivityInput> = {
	input: recentActivityInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.EDITOR);
		if (!user.ok) throw toRouteError(user.error);
		const limit = ctx.input.limit ?? 20;
		return unwrap(await analytics.recentActivity(ctx, user.data.id, limit));
	},
};

const courseOverviewRoute: PluginRoute<CourseIdInput> = {
	input: courseIdInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.EDITOR);
		if (!user.ok) throw toRouteError(user.error);
		const instr = await requireInstructor(ctx, user.data.id, ctx.input.courseId);
		if (!instr.ok) throw toRouteError(instr.error);
		return unwrap(await analytics.courseOverview(ctx, ctx.input.courseId));
	},
};

const courseEnrollmentsTimelineRoute: PluginRoute<TimelineInput> = {
	input: timelineInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.EDITOR);
		if (!user.ok) throw toRouteError(user.error);
		const instr = await requireInstructor(ctx, user.data.id, ctx.input.courseId);
		if (!instr.ok) throw toRouteError(instr.error);
		const days = ctx.input.days ?? 30;
		return unwrap(await analytics.courseEnrollmentsTimeline(ctx, ctx.input.courseId, days));
	},
};

const courseCompletionFunnelRoute: PluginRoute<CourseIdInput> = {
	input: courseIdInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.EDITOR);
		if (!user.ok) throw toRouteError(user.error);
		const instr = await requireInstructor(ctx, user.data.id, ctx.input.courseId);
		if (!instr.ok) throw toRouteError(instr.error);
		return unwrap(await analytics.courseCompletionFunnel(ctx, ctx.input.courseId));
	},
};

const courseProgressMatrixRoute: PluginRoute<ProgressMatrixInput> = {
	input: progressMatrixInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.EDITOR);
		if (!user.ok) throw toRouteError(user.error);
		const instr = await requireInstructor(ctx, user.data.id, ctx.input.courseId);
		if (!instr.ok) throw toRouteError(instr.error);
		const opts: { cursor?: string; limit?: number } = {};
		if (ctx.input.cursor !== undefined) opts.cursor = ctx.input.cursor;
		if (ctx.input.limit !== undefined) opts.limit = ctx.input.limit;
		return unwrap(await analytics.courseProgressMatrix(ctx, ctx.input.courseId, opts));
	},
};

const courseQuizStatsRoute: PluginRoute<CourseIdInput> = {
	input: courseIdInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.EDITOR);
		if (!user.ok) throw toRouteError(user.error);
		const instr = await requireInstructor(ctx, user.data.id, ctx.input.courseId);
		if (!instr.ok) throw toRouteError(instr.error);
		return unwrap(await analytics.courseQuizStats(ctx, ctx.input.courseId));
	},
};

const studentProgressRoute: PluginRoute<StudentProgressInput> = {
	input: studentProgressInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.EDITOR);
		if (!user.ok) throw toRouteError(user.error);
		return unwrap(
			await analytics.studentProgressAcrossCourses(ctx, user.data.id, ctx.input.studentId),
		);
	},
};

const enrollmentsExportRoute: PluginRoute<CourseIdInput> = {
	input: courseIdInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.EDITOR);
		if (!user.ok) throw toRouteError(user.error);
		const instr = await requireInstructor(ctx, user.data.id, ctx.input.courseId);
		if (!instr.ok) throw toRouteError(instr.error);
		const matrix = unwrap(
			await analytics.courseProgressMatrix(ctx, ctx.input.courseId, { limit: 200 }),
		);
		return { csv: progressMatrixToCsv(matrix) };
	},
};

const progressExportRoute: PluginRoute<CourseIdInput> = {
	input: courseIdInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.EDITOR);
		if (!user.ok) throw toRouteError(user.error);
		const instr = await requireInstructor(ctx, user.data.id, ctx.input.courseId);
		if (!instr.ok) throw toRouteError(instr.error);
		const matrix = unwrap(
			await analytics.courseProgressMatrix(ctx, ctx.input.courseId, { limit: 200 }),
		);
		return { csv: progressMatrixToCsv(matrix) };
	},
};

export const instructorAnalyticsRoutes = {
	"instructor:dashboard-stats": dashboardStatsRoute,
	"instructor:dashboard-courses": dashboardCoursesRoute,
	"instructor:recent-activity": recentActivityRoute,
	"instructor:course-overview": courseOverviewRoute,
	"instructor:course-enrollments-timeline": courseEnrollmentsTimelineRoute,
	"instructor:course-completion-funnel": courseCompletionFunnelRoute,
	"instructor:course-progress-matrix": courseProgressMatrixRoute,
	"instructor:course-quiz-stats": courseQuizStatsRoute,
	"instructor:student-progress": studentProgressRoute,
	"instructor:enrollments-export": enrollmentsExportRoute,
	"instructor:progress-export": progressExportRoute,
} as const;

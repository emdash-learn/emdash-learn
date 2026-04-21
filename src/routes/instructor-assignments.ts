/**
 * Instructor assignment routes (T11 / §6.3 `instructor:set` + `instructor:unset`,
 * T23 `instructor:list`).
 *
 * All three are ADMIN-only (emdash `Role.ADMIN = 50`). The underlying
 * authorization surface `course_instructors` is independent of emdash's role
 * ladder (§2 + §5.3), so managing that relation is deliberately kept behind
 * the ADMIN gate — no EDITOR-can-assign-themselves trap door.
 *
 *   POST /_emdash/api/plugins/lms-core/instructor:set
 *     { courseId: string, userId: string, role: "lead"|"co"|"ta" }
 *     -> { ok: true, assignment: CourseInstructor }
 *
 *   POST /_emdash/api/plugins/lms-core/instructor:unset
 *     { courseId: string, userId: string }
 *     -> { ok: true }
 *
 *   POST /_emdash/api/plugins/lms-core/instructor:list
 *     {}
 *     -> { items: Array<InstructorListItem> }
 *
 * `instructor:list` hydrates each row with user + course metadata so the
 * §16.9 admin page can render "Maya Okafor — React Fundamentals (lead)"
 * without issuing per-row follow-up calls.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute } from "emdash";

import { type AuthContext, Role, requireRole } from "../authz.js";
import { LEARN_ERRORS } from "../constants.js";
import * as instructors from "../engine/instructors.js";
import type { Result, ResultError } from "../engine/result.js";
import type { CourseInstructor, InstructorRole } from "../types/storage.js";
import { ensureSetupComplete } from "../setup-gate.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const instructorSetInput = z.object({
	courseId: z.string().min(1),
	userId: z.string().min(1),
	role: z.enum(["lead", "co", "ta"]),
});
export type InstructorSetInput = z.infer<typeof instructorSetInput>;

export const instructorUnsetInput = z.object({
	courseId: z.string().min(1),
	userId: z.string().min(1),
});
export type InstructorUnsetInput = z.infer<typeof instructorUnsetInput>;

/**
 * `instructor:list` takes no input today; keep a schema stub so future
 * filters (courseId, userId, cursor) can be added without a breaking change.
 */
export const instructorListInput = z.object({}).strict();
export type InstructorListInput = z.infer<typeof instructorListInput>;

export interface InstructorListItem {
	courseId: string;
	courseTitle?: string;
	userId: string;
	userName?: string;
	userEmail?: string;
	role: InstructorRole;
}

export interface InstructorListResponse {
	items: InstructorListItem[];
}

// ---------------------------------------------------------------------------
// Error → HTTP mapping (§17.6)
// ---------------------------------------------------------------------------

function statusForCode(code: string): number {
	switch (code) {
		case LEARN_ERRORS.UNAUTHENTICATED:
			return 401;
		case LEARN_ERRORS.FORBIDDEN:
		case LEARN_ERRORS.NOT_INSTRUCTOR:
			return 403;
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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const setRoute: PluginRoute<InstructorSetInput> = {
	input: instructorSetInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.ADMIN);
		if (!user.ok) throw toRouteError(user.error);

		const { courseId, userId, role } = ctx.input;
		const result = await instructors.assign(ctx, courseId, userId, role);
		const assignment = unwrap(result);
		return { ok: true, assignment };
	},
};

const unsetRoute: PluginRoute<InstructorUnsetInput> = {
	input: instructorUnsetInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.ADMIN);
		if (!user.ok) throw toRouteError(user.error);

		const { courseId, userId } = ctx.input;
		const result = await instructors.unassign(ctx, courseId, userId);
		unwrap(result);
		return { ok: true };
	},
};

/**
 * Build an `InstructorListItem` from a raw assignment row plus best-effort
 * user + course lookups. Cache-aware: the caller maintains two maps so each
 * user and course is fetched at most once per request.
 */
async function hydrateAssignment(
	ctx: Parameters<PluginRoute<InstructorListInput>["handler"]>[0],
	row: CourseInstructor,
	userCache: Map<string, { name?: string; email?: string }>,
	courseCache: Map<string, string | undefined>,
): Promise<InstructorListItem> {
	if (!userCache.has(row.userId) && ctx.users?.get) {
		const u = await ctx.users.get(row.userId);
		if (u) {
			const entry: { name?: string; email?: string } = {};
			if (typeof u.name === "string" && u.name.length > 0) entry.name = u.name;
			if (typeof u.email === "string" && u.email.length > 0) entry.email = u.email;
			userCache.set(row.userId, entry);
		} else {
			userCache.set(row.userId, {});
		}
	}
	if (!courseCache.has(row.courseId) && ctx.content) {
		const c = await ctx.content.get("courses", row.courseId);
		const title = c
			? ((c.data as Record<string, unknown>)["title"] as string | undefined)
			: undefined;
		courseCache.set(row.courseId, title);
	}

	const userInfo = userCache.get(row.userId);
	const item: InstructorListItem = {
		courseId: row.courseId,
		userId: row.userId,
		role: row.role,
	};
	const courseTitle = courseCache.get(row.courseId);
	if (courseTitle) item.courseTitle = courseTitle;
	if (userInfo?.name) item.userName = userInfo.name;
	if (userInfo?.email) item.userEmail = userInfo.email;
	return item;
}

const listRoute: PluginRoute<InstructorListInput> = {
	input: instructorListInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.ADMIN);
		if (!user.ok) throw toRouteError(user.error);

		const rows = await instructors.listAll(ctx);
		const userCache = new Map<string, { name?: string; email?: string }>();
		const courseCache = new Map<string, string | undefined>();
		// Sequential hydration — caches mutate inside the loop so parallel
		// Promise.all would spawn duplicate ctx.users.get / ctx.content.get
		// calls for users or courses that appear multiple times.
		/* oxlint-disable no-await-in-loop */
		const items: InstructorListItem[] = [];
		for (const row of rows) {
			items.push(await hydrateAssignment(ctx, row, userCache, courseCache));
		}
		/* oxlint-enable no-await-in-loop */
		const response: InstructorListResponse = { items };
		return response;
	},
};

export const instructorAssignmentRoutes = {
	"instructor:set": setRoute,
	"instructor:unset": unsetRoute,
	"instructor:list": listRoute,
} as const;

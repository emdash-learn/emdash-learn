/**
 * Instructor assignment routes (T11 / §6.3 `instructor:set` + `instructor:unset`).
 *
 * Both are ADMIN-only (emdash `Role.ADMIN = 50`). The underlying authorization
 * surface `course_instructors` is independent of emdash's role ladder (§2 +
 * §5.3), so managing that relation is deliberately kept behind the ADMIN gate
 * — no EDITOR-can-assign-themselves trap door.
 *
 *   POST /_emdash/api/plugins/lms-core/instructor:set
 *     { courseId: string, userId: string, role: "lead"|"co"|"ta" }
 *     -> { ok: true, assignment: CourseInstructor }
 *
 *   POST /_emdash/api/plugins/lms-core/instructor:unset
 *     { courseId: string, userId: string }
 *     -> { ok: true }
 *
 * Both routes:
 *   - validate input via Zod,
 *   - gate on `requireRole(ADMIN)`,
 *   - delegate to `engine/instructors.ts` (idempotent — re-driving either
 *     route returns `ok` without error),
 *   - map `Result.error` to a `PluginRouteError` with the §17.6 HTTP status.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute } from "emdash";

import { type AuthContext, Role, requireRole } from "../authz.js";
import { LEARN_ERRORS } from "../constants.js";
import * as instructors from "../engine/instructors.js";
import type { Result, ResultError } from "../engine/result.js";

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
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.ADMIN);
		if (!user.ok) throw toRouteError(user.error);

		const { courseId, userId } = ctx.input;
		const result = await instructors.unassign(ctx, courseId, userId);
		unwrap(result);
		return { ok: true };
	},
};

export const instructorAssignmentRoutes = {
	"instructor:set": setRoute,
	"instructor:unset": unsetRoute,
} as const;

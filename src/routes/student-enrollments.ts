/**
 * Student enrollment routes (T05 / §6.1).
 *
 *   POST /_emdash/api/plugins/lms-core/enroll
 *     { courseId, source, cohortId?, orderId? }
 *     -> { ok: true, enrollmentId, enrollment }
 *
 *   POST /_emdash/api/plugins/lms-core/unenroll
 *     { enrollmentId, reason? }
 *     -> { ok: true, enrollment }
 *
 * `enroll` is `role>=SUBSCRIBER`. `unenroll` is `owner` — the route loads the
 * target row and refuses callers whose `user.id !== row.userId`, matching
 * `requireOwner` from T03 (§6.1 auth column). All business rules (window
 * check, dedupe, event emission) live in `engine/enrollments.ts`.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute } from "emdash";

import { type AuthContext, Role, requireOwner, requireRole } from "../authz.js";
import { LEARN_ERRORS } from "../constants.js";
import * as enrollments from "../engine/enrollments.js";
import type { Result, ResultError } from "../engine/result.js";

// ---------------------------------------------------------------------------
// Zod schemas (§23)
// ---------------------------------------------------------------------------

const enrollmentSource = z.enum(["free", "purchase", "invite", "admin"]);

export const enrollInput = z.object({
	courseId: z.string().min(1),
	cohortId: z.string().optional(),
	source: enrollmentSource,
	orderId: z.string().optional(),
});
export type EnrollInput = z.infer<typeof enrollInput>;

export const unenrollInput = z.object({
	enrollmentId: z.string().min(1),
	reason: z.string().max(500).optional(),
});
export type UnenrollInput = z.infer<typeof unenrollInput>;

// ---------------------------------------------------------------------------
// Error → HTTP mapping (§17.6)
// ---------------------------------------------------------------------------

function statusForCode(code: string): number {
	switch (code) {
		case LEARN_ERRORS.UNAUTHENTICATED:
			return 401;
		case LEARN_ERRORS.FORBIDDEN:
		case LEARN_ERRORS.NOT_ENROLLED:
		case LEARN_ERRORS.ENROLLMENT_CLOSED:
			return 403;
		case LEARN_ERRORS.ALREADY_ENROLLED:
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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const enrollRoute: PluginRoute<EnrollInput> = {
	input: enrollInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.SUBSCRIBER);
		if (!user.ok) throw toRouteError(user.error);

		const input = ctx.input;
		const grantInput: Parameters<typeof enrollments.grant>[2] = {
			courseId: input.courseId,
			source: input.source,
		};
		if (input.cohortId !== undefined) grantInput.cohortId = input.cohortId;
		if (input.orderId !== undefined) grantInput.orderId = input.orderId;

		const result = await enrollments.grant(ctx, user.data.id, grantInput);
		const enrollment = unwrap(result);

		const row = await enrollments.listByUser(ctx, user.data.id, { status: "all", limit: 100 });
		const matched = row.ok
			? row.data.items.find((item) => item.data.courseId === input.courseId)
			: undefined;

		return {
			ok: true,
			enrollmentId: matched?.id,
			enrollment,
		};
	},
};

const unenrollRoute: PluginRoute<UnenrollInput> = {
	input: unenrollInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.SUBSCRIBER);
		if (!user.ok) throw toRouteError(user.error);

		// Ownership check — load the row, confirm `user.id === row.userId`
		// before mutating. Engine `revoke` alone would let any authenticated
		// student revoke any other student's enrollment.
		const lookup = await enrollments.getById(ctx, ctx.input.enrollmentId);
		const record = unwrap(lookup);
		const owner = requireOwner(ctx, user.data.id, record.data);
		if (!owner.ok) throw toRouteError(owner.error);

		const result = await enrollments.revoke(ctx, ctx.input.enrollmentId, ctx.input.reason);
		const updated = unwrap(result);
		return { ok: true, enrollment: updated };
	},
};

export const enrollmentRoutes = {
	enroll: enrollRoute,
	unenroll: unenrollRoute,
} as const;

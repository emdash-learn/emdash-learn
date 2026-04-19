/**
 * Student progress routes (T06).
 *
 * Two POST endpoints, both `owner`-scoped per §6.1:
 *
 *   POST /_emdash/api/plugins/lms-core/progress:tick
 *     {
 *       lessonId: string,
 *       positionSeconds: int >= 0,
 *       percentComplete: number 0..100   // crossing 90 auto-completes (§8.2)
 *     }
 *     -> { ok: true, progress: Progress }
 *
 *   POST /_emdash/api/plugins/lms-core/progress:complete
 *     { lessonId: string }
 *     -> { ok: true, courseComplete: boolean }
 *
 * Both routes:
 *   - validate input via Zod (§23 sketches),
 *   - run `requireRole(SUBSCRIBER)` (the `owner` semantic for self-progress
 *     means: must be authenticated; we always operate on `ctx.user.id`,
 *     never a caller-supplied userId — the route never accepts one),
 *   - delegate to `engine/progress.ts`,
 *   - map a `Result.error` to a typed `PluginRouteError` so emdash returns
 *     a structured non-200 with a stable `LEARN_*` code (§24 row 13).
 *
 * Engine logic (the 90% auto-complete, the course-complete eval, the
 * `lesson:completed` / `course:completed` emissions, idempotency) is in
 * `engine/progress.ts` — this file is the thin authz/transport boundary
 * mandated by §17.2 ("if a route is more than 20 lines, the logic belongs
 * in the engine").
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute } from "emdash";

import { type AuthContext, Role, requireRole } from "../authz.js";
import { LEARN_ERRORS } from "../constants.js";
import * as progress from "../engine/progress.js";
import type { Result, ResultError } from "../engine/result.js";

// ---------------------------------------------------------------------------
// Zod schemas (§23)
// ---------------------------------------------------------------------------

/**
 * Mirrors `progressTickInput` in §23, updated for the topics primitive
 * (ADR 0001) — `lessonId` becomes `stepId` + `stepType`.
 */
export const progressTickInput = z.object({
	stepType: z.enum(["lesson", "topic"]),
	stepId: z.string().min(1),
	positionSeconds: z.number().int().nonnegative(),
	percentComplete: z.number().min(0).max(100),
});
export type ProgressTickInput = z.infer<typeof progressTickInput>;

export const progressCompleteInput = z.object({
	stepType: z.enum(["lesson", "topic"]),
	stepId: z.string().min(1),
});
export type ProgressCompleteInput = z.infer<typeof progressCompleteInput>;

// ---------------------------------------------------------------------------
// Error → HTTP mapping
// ---------------------------------------------------------------------------

/**
 * Map a `LEARN_*` error code to the HTTP status defined in §17.6's taxonomy.
 * Anything unknown defaults to 400 — engine code only ever returns documented
 * codes, so an unknown code at this layer is itself a programming error
 * worth surfacing as a 4xx (rather than swallowing as 500).
 */
function statusForCode(code: string): number {
	switch (code) {
		case LEARN_ERRORS.UNAUTHENTICATED:
			return 401;
		case LEARN_ERRORS.FORBIDDEN:
		case LEARN_ERRORS.NOT_ENROLLED:
		case LEARN_ERRORS.NOT_INSTRUCTOR:
		case LEARN_ERRORS.LESSON_LOCKED:
		case LEARN_ERRORS.TOPIC_LOCKED:
		case LEARN_ERRORS.ENROLLMENT_CLOSED:
			return 403;
		case LEARN_ERRORS.QUIZ_NOT_STARTED:
		case LEARN_ERRORS.CERT_NOT_FOUND:
			return 404;
		case LEARN_ERRORS.ALREADY_ENROLLED:
		case LEARN_ERRORS.COHORT_AT_CAPACITY:
		case LEARN_ERRORS.QUIZ_TIMEOUT:
		case LEARN_ERRORS.COURSE_HAS_ENROLLMENTS:
		case LEARN_ERRORS.SETUP_INCOMPLETE:
			return 409;
		default:
			return 400;
	}
}

/**
 * Throw the matching `PluginRouteError` so emdash's route dispatcher returns
 * a structured `{ success: false, error: { code, message } }` envelope with
 * the right status. Routes never return `Result` directly — they always
 * unwrap at the boundary (D35).
 */
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

/**
 * `progress:tick` — heartbeat from the lesson player. Called every ~15s
 * (D20). Returns the current `progress` row so the player can reconcile
 * (some clients display "X% complete" after the tick lands).
 */
const tickRoute: PluginRoute<ProgressTickInput> = {
	input: progressTickInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.SUBSCRIBER);
		if (!user.ok) throw toRouteError(user.error);

		const result = await progress.tick(ctx, user.data.id, {
			stepType: ctx.input.stepType,
			stepId: ctx.input.stepId,
			positionSeconds: ctx.input.positionSeconds,
			percentComplete: ctx.input.percentComplete,
		});
		const row = unwrap(result);
		return { ok: true, progress: row };
	},
};

/**
 * `progress:complete` — explicit "I'm done with this lesson" from the
 * player. Returns whether the whole course is now complete so the client
 * can swap to the celebration UI immediately.
 */
const completeRoute: PluginRoute<ProgressCompleteInput> = {
	input: progressCompleteInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.SUBSCRIBER);
		if (!user.ok) throw toRouteError(user.error);

		const result = await progress.markStepComplete(
			ctx,
			user.data.id,
			ctx.input.stepType,
			ctx.input.stepId,
		);
		const data = unwrap(result);
		return { ok: true, courseComplete: data.courseComplete };
	},
};

/**
 * Wave-3 ownership rule (§26): each task exports a named `*Routes` object
 * and the orchestrator composes them into the descriptor's `routes` field
 * in `src/sandbox-entry.ts` as the final compose step. T06 owns this file
 * and does not touch `sandbox-entry.ts`.
 */
export const progressRoutes = {
	"progress:tick": tickRoute,
	"progress:complete": completeRoute,
} as const;

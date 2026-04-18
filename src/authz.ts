/**
 * Authorization primitives (T03). Every route handler that needs gating calls
 * exactly one of these four helpers at the top of its body and branches on the
 * returned `Result`:
 *
 *   - `requireRole(ctx, minRole)`              — session user meets the role
 *     ladder (§2, emdash/auth `Role`).
 *   - `requireInstructor(ctx, userId, courseId)` — plugin-storage row in
 *     `course_instructors` (§2, §5.3). Emdash's 5-role ladder has no
 *     "instructor" tier, so instructor-of-X is a per-course relation
 *     independent of `EDITOR` role.
 *   - `requireEnrolled(ctx, userId, courseId)`  — plugin-storage row in
 *     `enrollments`; rows with `revokedAt` set count as not-enrolled.
 *   - `requireOwner(ctx, userId, resource)`     — resource.userId match for
 *     student-facing routes that mutate their own progress/attempts.
 *
 * All four return `Result<T>` (§17.5 / D35); callers unwrap at the route
 * boundary. Error codes are drawn from `LEARN_ERRORS` (§17.6): `FORBIDDEN`
 * covers role-and-owner denials, `NOT_INSTRUCTOR`/`NOT_ENROLLED` cover their
 * dedicated deny paths, and `UNAUTHENTICATED` covers the "no session user"
 * case uniformly across helpers.
 */

import type { PluginContext, StorageCollection } from "emdash";

import { LEARN_ERRORS } from "./constants.js";
import { err, ok, type Result } from "./engine/result.js";
import type { CourseInstructor, Enrollment } from "./types/storage.js";

/**
 * Numeric role levels mirroring `@emdash-cms/auth`
 * (`packages/auth/src/types.ts:9`). Duplicated here because the `emdash`
 * npm package (v0.5.0) does not re-export `Role` / `RoleLevel`.
 * See §12 Q22 for the follow-up on an upstream re-export. Values MUST stay
 * aligned with the auth package.
 */
export const Role = {
	SUBSCRIBER: 10,
	CONTRIBUTOR: 20,
	AUTHOR: 30,
	EDITOR: 40,
	ADMIN: 50,
} as const;

export type RoleLevel = (typeof Role)[keyof typeof Role];

/**
 * Mirror of `UserInfo` (emdash `packages/core/src/plugins/types.ts:364`). The
 * `emdash` package references this shape in `PluginContext['users']` but does
 * not export the type directly — see §12 Q22.
 */
export interface UserInfo {
	id: string;
	email: string;
	name: string | null;
	role: number;
	createdAt: string;
}

/**
 * `AuthContext` is the per-request plugin context extended with the resolved
 * session user. Route handlers populate `user` from the emdash session layer
 * (cookie/token) before calling `requireRole` so the authz surface stays
 * agnostic of transport.
 */
export interface AuthContext extends PluginContext {
	user: UserInfo | null;
}

/** Human-readable fallback message for the no-session case. */
const UNAUTHENTICATED_MESSAGE = "Authentication required";

/**
 * Narrow `ctx.storage[name]` out of the generic `Record<string, StorageCollection>`
 * access type. Plugin storage is declared in the descriptor (§17.3), so the
 * collection is always present at runtime; a missing key means the descriptor
 * drifted from authz — a programmer error, not a request-time failure mode.
 */
function getCollection<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	const collection = (ctx.storage as Record<string, StorageCollection | undefined>)[name];
	if (!collection) {
		throw new Error(`Plugin storage collection "${name}" is not declared in the descriptor.`);
	}
	return collection as StorageCollection<T>;
}

export function requireRole(ctx: AuthContext, minRole: number): Result<UserInfo> {
	if (!ctx.user) return err(LEARN_ERRORS.UNAUTHENTICATED, UNAUTHENTICATED_MESSAGE);
	if (ctx.user.role < minRole) {
		return err(
			LEARN_ERRORS.FORBIDDEN,
			`User role ${ctx.user.role} is below required role ${minRole}`,
		);
	}
	return ok(ctx.user);
}

export async function requireInstructor(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<Result<CourseInstructor>> {
	if (!userId) return err(LEARN_ERRORS.UNAUTHENTICATED, UNAUTHENTICATED_MESSAGE);
	// Composite index (courseId, userId) in the descriptor makes this a
	// point-lookup against plugin storage; `limit: 1` keeps it O(1).
	const collection = getCollection<CourseInstructor>(ctx, "course_instructors");
	const result = await collection.query({ where: { userId, courseId }, limit: 1 });
	const row = result.items[0];
	if (!row) {
		return err(
			LEARN_ERRORS.NOT_INSTRUCTOR,
			`User ${userId} is not an instructor of course ${courseId}`,
		);
	}
	return ok(row.data);
}

export async function requireEnrolled(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<Result<Enrollment>> {
	if (!userId) return err(LEARN_ERRORS.UNAUTHENTICATED, UNAUTHENTICATED_MESSAGE);
	const collection = getCollection<Enrollment>(ctx, "enrollments");
	const result = await collection.query({ where: { userId, courseId }, limit: 1 });
	const row = result.items[0];
	if (!row || row.data.revokedAt) {
		return err(LEARN_ERRORS.NOT_ENROLLED, `User ${userId} is not enrolled in course ${courseId}`);
	}
	return ok(row.data);
}

export function requireOwner<T extends { userId: string }>(
	_ctx: PluginContext,
	userId: string,
	resource: T,
): Result<T> {
	if (!userId) return err(LEARN_ERRORS.UNAUTHENTICATED, UNAUTHENTICATED_MESSAGE);
	if (resource.userId !== userId) {
		return err(LEARN_ERRORS.FORBIDDEN, "Caller does not own this resource");
	}
	return ok(resource);
}

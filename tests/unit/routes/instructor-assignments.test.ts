/**
 * Unit tests for `src/routes/instructor-assignments.ts`.
 *
 * T11 shipped `instructor:set` / `instructor:unset` without route-level unit
 * tests (integration coverage lives in `engine/instructors.test.ts`). T23
 * adds `instructor:list` for the §16.9 admin page and backfills a minimal
 * route-table test alongside focused coverage for the new handler:
 *
 *   - hydration via `ctx.users.get` and `ctx.content.get`,
 *   - graceful fallback when the userId / courseId can't be resolved,
 *   - caching so repeated users/courses don't trigger duplicate lookups,
 *   - `requireRole(ADMIN)` gate rejecting non-admin callers.
 */

import { describe, expect, it, vi } from "vitest";

import { Role } from "../../../src/authz.js";
import { LEARN_ERRORS } from "../../../src/constants.js";
import {
	instructorAssignmentRoutes,
	type InstructorListResponse,
} from "../../../src/routes/instructor-assignments.js";
import type { CourseInstructor } from "../../../src/types/storage.js";

interface StoredRow<T> {
	id: string;
	data: T;
}

function makeCourseInstructorsStub(initial: Array<StoredRow<CourseInstructor>> = []) {
	const rows: Array<StoredRow<CourseInstructor>> = [...initial];
	return {
		rows,
		async get(id: string): Promise<CourseInstructor | null> {
			return rows.find((r) => r.id === id)?.data ?? null;
		},
		async put(id: string, data: CourseInstructor): Promise<void> {
			const i = rows.findIndex((r) => r.id === id);
			if (i >= 0) rows[i] = { id, data };
			else rows.push({ id, data });
		},
		async delete(id: string): Promise<boolean> {
			const i = rows.findIndex((r) => r.id === id);
			if (i < 0) return false;
			rows.splice(i, 1);
			return true;
		},
		async query(opts?: { where?: Partial<CourseInstructor>; limit?: number }) {
			const where = opts?.where ?? {};
			const filtered = rows.filter((r) =>
				Object.entries(where).every(([k, v]) => (r.data as Record<string, unknown>)[k] === v),
			);
			return {
				items: typeof opts?.limit === "number" ? filtered.slice(0, opts.limit) : filtered,
				hasMore: false,
			};
		},
	};
}

interface MakeCtxOpts {
	roleLevel?: number;
	assignments?: Array<StoredRow<CourseInstructor>>;
	users?: Record<string, { id: string; email: string; name?: string }>;
	courses?: Record<string, { title?: string }>;
}

function makeCtx(opts: MakeCtxOpts = {}) {
	const courseInstructors = makeCourseInstructorsStub(opts.assignments ?? []);
	const usersMap = opts.users ?? {};
	const coursesMap = opts.courses ?? {};
	const getUserSpy = vi.fn(async (id: string) => usersMap[id] ?? null);
	const getCourseSpy = vi.fn(async (collection: string, id: string) => {
		if (collection !== "courses") return null;
		const c = coursesMap[id];
		if (!c) return null;
		return { id, data: c };
	});
	const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const user = {
		id: "u_admin",
		email: "admin@x.com",
		name: "Admin",
		role: opts.roleLevel ?? Role.ADMIN,
		createdAt: "2026-01-01T00:00:00Z",
	};

	function buildRouteCtx(input: unknown) {
		return {
			input,
			storage: { course_instructors: courseInstructors },
			log,
			user,
			users: { get: getUserSpy },
			content: { get: getCourseSpy },
			request: new Request("https://example.invalid/x", { method: "POST" }),
			requestMeta: { ip: null, userAgent: null, referer: null, geo: null },
		} as unknown as Parameters<
			(typeof instructorAssignmentRoutes)["instructor:list"]["handler"]
		>[0];
	}

	return { courseInstructors, getUserSpy, getCourseSpy, user, buildRouteCtx };
}

describe("instructorAssignmentRoutes table", () => {
	it("exports exactly the three ADMIN assignment routes", () => {
		expect(Object.keys(instructorAssignmentRoutes).toSorted()).toEqual([
			"instructor:list",
			"instructor:set",
			"instructor:unset",
		]);
	});
});

describe("instructor:list route", () => {
	it("hydrates items with user names and course titles", async () => {
		const { buildRouteCtx } = makeCtx({
			assignments: [
				{ id: "ci_1", data: { courseId: "c_react", userId: "u_maya", role: "lead" } },
				{ id: "ci_2", data: { courseId: "c_sql", userId: "u_maya", role: "co" } },
				{ id: "ci_3", data: { courseId: "c_sql", userId: "u_ben", role: "lead" } },
			],
			users: {
				u_maya: { id: "u_maya", email: "maya@x.com", name: "Maya Okafor" },
				u_ben: { id: "u_ben", email: "ben@x.com", name: "Ben Tanaka" },
			},
			courses: {
				c_react: { title: "React Fundamentals" },
				c_sql: { title: "SQL" },
			},
		});
		const route = instructorAssignmentRoutes["instructor:list"];
		const input = route.input!.parse({});
		const result = (await route.handler(buildRouteCtx(input))) as InstructorListResponse;

		expect(result.items).toHaveLength(3);
		const maya = result.items.find((i) => i.userId === "u_maya" && i.courseId === "c_react");
		expect(maya).toEqual({
			courseId: "c_react",
			courseTitle: "React Fundamentals",
			userId: "u_maya",
			userName: "Maya Okafor",
			userEmail: "maya@x.com",
			role: "lead",
		});
	});

	it("falls back cleanly when lookups return null", async () => {
		const { buildRouteCtx } = makeCtx({
			assignments: [
				{ id: "ci_1", data: { courseId: "c_unknown", userId: "u_unknown", role: "ta" } },
			],
		});
		const route = instructorAssignmentRoutes["instructor:list"];
		const input = route.input!.parse({});
		const result = (await route.handler(buildRouteCtx(input))) as InstructorListResponse;
		expect(result.items).toEqual([{ courseId: "c_unknown", userId: "u_unknown", role: "ta" }]);
	});

	it("caches repeat users + courses across rows", async () => {
		const { buildRouteCtx, getUserSpy, getCourseSpy } = makeCtx({
			assignments: [
				{ id: "ci_1", data: { courseId: "c1", userId: "u1", role: "lead" } },
				{ id: "ci_2", data: { courseId: "c1", userId: "u1", role: "co" } },
				{ id: "ci_3", data: { courseId: "c1", userId: "u2", role: "ta" } },
			],
			users: {
				u1: { id: "u1", email: "a@x.com", name: "A" },
				u2: { id: "u2", email: "b@x.com", name: "B" },
			},
			courses: { c1: { title: "Course 1" } },
		});
		const route = instructorAssignmentRoutes["instructor:list"];
		const input = route.input!.parse({});
		await route.handler(buildRouteCtx(input));
		expect(getUserSpy).toHaveBeenCalledTimes(2);
		expect(getCourseSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects non-admin callers with FORBIDDEN", async () => {
		const { buildRouteCtx } = makeCtx({ roleLevel: Role.EDITOR });
		const route = instructorAssignmentRoutes["instructor:list"];
		const input = route.input!.parse({});
		await expect(route.handler(buildRouteCtx(input))).rejects.toMatchObject({
			code: LEARN_ERRORS.FORBIDDEN,
		});
	});
});

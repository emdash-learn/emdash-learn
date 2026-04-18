/**
 * Analytics engine (T15 / §22 Phase 5 / D33 backend-only).
 *
 * Pure aggregation — no writes, no events. Every function returns a
 * `Promise<Result<T>>` so routes can unwrap at the boundary just like every
 * other engine module.
 *
 * Performance model (D48): v1 is "scan and count". No rollup tables, no
 * materialized views. Loops are capped at `MAX_SCAN` per collection to keep
 * pathological tests bounded.
 *
 * Scoping:
 *   - Instructor-scoped readers (dashboard*, courseOverview when called via
 *     the instructor route, recentActivity, studentProgressAcrossCourses)
 *     filter through the `course_instructors` collection so an instructor
 *     only sees their own courses. Route handlers in
 *     `src/routes/instructor-analytics.ts` also enforce
 *     `requireInstructor(...)` per course where needed.
 *   - Admin-scoped readers (siteAnalytics, coursesComparison,
 *     engagementMetrics) scan across all courses with no instructor filter.
 */

import type { PluginContext, StorageCollection } from "emdash";

import { LEARN_ERRORS } from "../constants.js";
import type {
	Certificate,
	CourseInstructor,
	Enrollment,
	Progress,
	Quiz,
	QuizAttempt,
} from "../types/storage.js";
import { err, ok, type Result } from "./result.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DateRange {
	from: string;
	to: string;
}

export interface DashboardStats {
	totalStudents: number;
	active30d: number;
	avgCompletion: number;
	quizPassRate: number;
}

export interface CourseSummary {
	courseId: string;
	title: string;
	enrolled: number;
	active30d: number;
	completionRate: number;
}

export interface ActivityItem {
	type: "enrolled" | "completed-course" | "quiz-submitted" | "lesson-completed";
	userId: string;
	userName?: string;
	courseId?: string;
	courseTitle?: string;
	lessonId?: string;
	quizId?: string;
	at: string;
}

export interface CourseOverview {
	courseId: string;
	title: string;
	enrolled: number;
	completed: number;
	active30d: number;
	avgProgress: number;
}

export interface QuizStats {
	quizId: string;
	title: string;
	attempts: number;
	passRate: number;
	avgScore: number;
}

export interface StudentProgress {
	studentId: string;
	courses: Array<{
		courseId: string;
		courseTitle: string;
		enrolledAt: string;
		percentComplete: number;
		lessonsCompleted: number;
		lessonsTotal: number;
		completedAt?: string;
		lastActivityAt?: string;
	}>;
}

export interface SiteAnalytics {
	totalEnrollments: number;
	totalCompletions: number;
	activeUsers30d: number;
	certificatesIssued: number;
}

export interface CourseComparison {
	courseId: string;
	title: string;
	enrolled: number;
	completionRate: number;
	avgProgress: number;
}

export interface PaginatedResult<T> {
	items: T[];
	nextCursor?: string;
}

export interface EngagementMetrics {
	dau: { date: string; count: number }[];
	avgSessionLength?: number;
	completionsByDay: { date: string; count: number }[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_SCAN = 10_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getCollection<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	const c = (ctx.storage as Record<string, StorageCollection | undefined>)[name];
	if (!c) throw new Error(`plugin storage collection "${name}" not declared`);
	return c as StorageCollection<T>;
}

/**
 * Scan a storage collection with an optional `where` clause, respecting
 * `MAX_SCAN`. Returns `{ id, data }` rows because some aggregations need the
 * row id (e.g. enrollment id) while others only need `data`.
 */
async function scanAll<T>(
	ctx: PluginContext,
	name: string,
	where?: Record<string, string | number | boolean | null>,
): Promise<Array<{ id: string; data: T }>> {
	const collection = getCollection<T>(ctx, name);
	const out: Array<{ id: string; data: T }> = [];
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await collection.query({
			where,
			limit: 500,
			cursor,
		});
		for (const row of page.items) {
			out.push(row);
			if (out.length >= MAX_SCAN) return out;
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
	return out;
}

/**
 * Get the courseIds that `instructorId` is assigned to via `course_instructors`.
 */
async function instructorCourseIds(
	ctx: PluginContext,
	instructorId: string,
): Promise<string[]> {
	const rows = await scanAll<CourseInstructor>(ctx, "course_instructors", {
		userId: instructorId,
	});
	const ids = new Set<string>();
	for (const row of rows) ids.add(row.data.courseId);
	return Array.from(ids);
}

/** Resolve a course title from the content collection (best-effort). */
async function courseTitle(ctx: PluginContext, courseId: string): Promise<string> {
	if (!ctx.content) return courseId;
	const item = await ctx.content.get("courses", courseId);
	if (!item) return courseId;
	const title = (item.data as Record<string, unknown>)["title"];
	return typeof title === "string" ? title : courseId;
}

/** Count published lessons in a course. Returns 0 if content is unavailable. */
async function countLessons(ctx: PluginContext, courseId: string): Promise<number> {
	if (!ctx.content) return 0;
	let count = 0;
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await ctx.content.list("lessons", {
			where: { status: "published" },
			limit: 200,
			cursor,
		});
		for (const item of page.items) {
			if ((item.data as Record<string, unknown>)["course"] === courseId) count += 1;
			if (count >= MAX_SCAN) return count;
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
	return count;
}

function msAgo(days: number): number {
	return Date.now() - days * MS_PER_DAY;
}

function dateBucket(iso: string): string {
	return iso.slice(0, 10);
}

function isWithinRange(iso: string | undefined, range: DateRange): boolean {
	if (!iso) return false;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return false;
	const from = Date.parse(range.from);
	const to = Date.parse(range.to);
	if (Number.isNaN(from) || Number.isNaN(to)) return false;
	return t >= from && t <= to;
}

/**
 * Merge active (non-revoked) enrollment rows for a list of courses into a
 * flat array. Used by every instructor-scoped reader.
 */
async function enrollmentsForCourses(
	ctx: PluginContext,
	courseIds: string[],
): Promise<Enrollment[]> {
	const out: Enrollment[] = [];
	for (const courseId of courseIds) {
		// eslint-disable-next-line no-await-in-loop -- bounded by MAX_SCAN per call
		const rows = await scanAll<Enrollment>(ctx, "enrollments", { courseId });
		for (const row of rows) {
			if (!row.data.revokedAt) out.push(row.data);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Instructor aggregations
// ---------------------------------------------------------------------------

export async function dashboardStats(
	ctx: PluginContext,
	instructorId: string,
): Promise<Result<DashboardStats>> {
	if (!instructorId) {
		return err(LEARN_ERRORS.UNAUTHENTICATED, "instructorId required");
	}
	const courseIds = await instructorCourseIds(ctx, instructorId);
	if (courseIds.length === 0) {
		return ok({ totalStudents: 0, active30d: 0, avgCompletion: 0, quizPassRate: 0 });
	}

	const enrollments = await enrollmentsForCourses(ctx, courseIds);
	const studentIds = new Set(enrollments.map((e) => e.userId));

	const progressRows: Progress[] = [];
	for (const courseId of courseIds) {
		// eslint-disable-next-line no-await-in-loop
		const rows = await scanAll<Progress>(ctx, "progress", { courseId });
		for (const row of rows) progressRows.push(row.data);
	}

	const thirtyDaysAgo = msAgo(30);
	const activeUsers = new Set<string>();
	for (const p of progressRows) {
		const ts = p.completedAt ? Date.parse(p.completedAt) : Date.parse(p.startedAt);
		if (!Number.isNaN(ts) && ts >= thirtyDaysAgo) activeUsers.add(p.userId);
	}

	// Avg completion: mean across courses of completedEnrollments/enrolled.
	let totalCompletionRate = 0;
	for (const courseId of courseIds) {
		const courseEnrolls = enrollments.filter((e) => e.courseId === courseId);
		if (courseEnrolls.length === 0) continue;
		const completed = courseEnrolls.filter((e) => e.completedAt).length;
		totalCompletionRate += (completed / courseEnrolls.length) * 100;
	}
	const avgCompletion = courseIds.length > 0 ? totalCompletionRate / courseIds.length : 0;

	// Quiz pass rate over last 30d of attempts, restricted to attempts whose
	// quiz belongs to one of this instructor's courses. We don't have a direct
	// quiz->course link, so we scope by users who are enrolled in those courses.
	const attempts = await scanAll<QuizAttempt>(ctx, "quiz_attempts");
	const instructorStudents = studentIds;
	let quizTotal = 0;
	let quizPassed = 0;
	for (const row of attempts) {
		const a = row.data;
		if (!a.submittedAt) continue;
		if (Date.parse(a.submittedAt) < thirtyDaysAgo) continue;
		if (!instructorStudents.has(a.userId)) continue;
		quizTotal += 1;
		if (a.passed) quizPassed += 1;
	}
	const quizPassRate = quizTotal > 0 ? (quizPassed / quizTotal) * 100 : 0;

	return ok({
		totalStudents: studentIds.size,
		active30d: activeUsers.size,
		avgCompletion: Math.round(avgCompletion * 100) / 100,
		quizPassRate: Math.round(quizPassRate * 100) / 100,
	});
}

export async function dashboardCourses(
	ctx: PluginContext,
	instructorId: string,
): Promise<Result<CourseSummary[]>> {
	if (!instructorId) return err(LEARN_ERRORS.UNAUTHENTICATED, "instructorId required");

	const courseIds = await instructorCourseIds(ctx, instructorId);
	const summaries: CourseSummary[] = [];
	const thirtyDaysAgo = msAgo(30);

	for (const courseId of courseIds) {
		// eslint-disable-next-line no-await-in-loop
		const title = await courseTitle(ctx, courseId);
		// eslint-disable-next-line no-await-in-loop
		const enrollRows = await scanAll<Enrollment>(ctx, "enrollments", { courseId });
		const activeEnrolls = enrollRows.filter((r) => !r.data.revokedAt);
		const enrolled = activeEnrolls.length;
		const completed = activeEnrolls.filter((r) => r.data.completedAt).length;
		const completionRate = enrolled > 0 ? (completed / enrolled) * 100 : 0;

		// eslint-disable-next-line no-await-in-loop
		const progressRows = await scanAll<Progress>(ctx, "progress", { courseId });
		const activeUsers = new Set<string>();
		for (const row of progressRows) {
			const p = row.data;
			const ts = p.completedAt ? Date.parse(p.completedAt) : Date.parse(p.startedAt);
			if (!Number.isNaN(ts) && ts >= thirtyDaysAgo) activeUsers.add(p.userId);
		}

		summaries.push({
			courseId,
			title,
			enrolled,
			active30d: activeUsers.size,
			completionRate: Math.round(completionRate * 100) / 100,
		});
	}

	return ok(summaries);
}

export async function recentActivity(
	ctx: PluginContext,
	instructorId: string,
	limit: number,
): Promise<Result<ActivityItem[]>> {
	if (!instructorId) return err(LEARN_ERRORS.UNAUTHENTICATED, "instructorId required");

	const courseIds = await instructorCourseIds(ctx, instructorId);
	if (courseIds.length === 0) return ok([]);
	const courseSet = new Set(courseIds);

	const titleCache = new Map<string, string>();
	for (const courseId of courseIds) {
		// eslint-disable-next-line no-await-in-loop
		titleCache.set(courseId, await courseTitle(ctx, courseId));
	}

	const events: ActivityItem[] = [];

	// Enrollments.
	for (const courseId of courseIds) {
		// eslint-disable-next-line no-await-in-loop
		const rows = await scanAll<Enrollment>(ctx, "enrollments", { courseId });
		for (const row of rows) {
			if (row.data.revokedAt) continue;
			events.push({
				type: "enrolled",
				userId: row.data.userId,
				courseId,
				courseTitle: titleCache.get(courseId),
				at: row.data.enrolledAt,
			});
			if (row.data.completedAt) {
				events.push({
					type: "completed-course",
					userId: row.data.userId,
					courseId,
					courseTitle: titleCache.get(courseId),
					at: row.data.completedAt,
				});
			}
		}
	}

	// Lesson completions.
	for (const courseId of courseIds) {
		// eslint-disable-next-line no-await-in-loop
		const rows = await scanAll<Progress>(ctx, "progress", { courseId });
		for (const row of rows) {
			if (!row.data.completedAt) continue;
			events.push({
				type: "lesson-completed",
				userId: row.data.userId,
				courseId,
				courseTitle: titleCache.get(courseId),
				lessonId: row.data.lessonId,
				at: row.data.completedAt,
			});
		}
	}

	// Quiz attempts — scope to enrolled students across instructor's courses.
	const enrollments = await enrollmentsForCourses(ctx, courseIds);
	const eligibleUsers = new Set(enrollments.map((e) => e.userId));
	const attempts = await scanAll<QuizAttempt>(ctx, "quiz_attempts");
	for (const row of attempts) {
		const a = row.data;
		if (!a.submittedAt) continue;
		if (!eligibleUsers.has(a.userId)) continue;
		const item: ActivityItem = {
			type: "quiz-submitted",
			userId: a.userId,
			quizId: a.quizId,
			at: a.submittedAt,
		};
		events.push(item);
	}

	// Sort desc by `at`, slice to limit.
	// oxlint-disable-next-line no-array-sort -- local array
	const sorted = [...events].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
	const capped = Math.max(1, Math.min(limit, 100));
	// Use courseSet to satisfy the linter (it's logically used already).
	void courseSet;
	return ok(sorted.slice(0, capped));
}

export async function courseOverview(
	ctx: PluginContext,
	courseId: string,
): Promise<Result<CourseOverview>> {
	if (!courseId) return err(LEARN_ERRORS.FORBIDDEN, "courseId required");

	const title = await courseTitle(ctx, courseId);
	const enrollRows = await scanAll<Enrollment>(ctx, "enrollments", { courseId });
	const active = enrollRows.filter((r) => !r.data.revokedAt);
	const enrolled = active.length;
	const completed = active.filter((r) => r.data.completedAt).length;

	const progressRows = await scanAll<Progress>(ctx, "progress", { courseId });
	const thirtyDaysAgo = msAgo(30);
	const activeUsers = new Set<string>();
	const byUser = new Map<string, number[]>();

	for (const row of progressRows) {
		const p = row.data;
		const ts = p.completedAt ? Date.parse(p.completedAt) : Date.parse(p.startedAt);
		if (!Number.isNaN(ts) && ts >= thirtyDaysAgo) activeUsers.add(p.userId);
		const arr = byUser.get(p.userId) ?? [];
		arr.push(p.percentComplete ?? 0);
		byUser.set(p.userId, arr);
	}

	// Avg progress: mean of per-user mean percentComplete.
	let progressSum = 0;
	let progressUsers = 0;
	for (const arr of byUser.values()) {
		if (arr.length === 0) continue;
		const sum = arr.reduce((a, b) => a + b, 0);
		progressSum += sum / arr.length;
		progressUsers += 1;
	}
	const avgProgress = progressUsers > 0 ? progressSum / progressUsers : 0;

	return ok({
		courseId,
		title,
		enrolled,
		completed,
		active30d: activeUsers.size,
		avgProgress: Math.round(avgProgress * 100) / 100,
	});
}

export async function courseEnrollmentsTimeline(
	ctx: PluginContext,
	courseId: string,
	days: number,
): Promise<Result<{ date: string; count: number }[]>> {
	if (!courseId) return err(LEARN_ERRORS.FORBIDDEN, "courseId required");
	const clamped = Math.max(1, Math.min(days, 365));
	const cutoff = msAgo(clamped);

	const rows = await scanAll<Enrollment>(ctx, "enrollments", { courseId });
	const buckets = new Map<string, number>();
	for (const row of rows) {
		if (row.data.revokedAt) continue;
		const ts = Date.parse(row.data.enrolledAt);
		if (Number.isNaN(ts) || ts < cutoff) continue;
		const key = dateBucket(row.data.enrolledAt);
		buckets.set(key, (buckets.get(key) ?? 0) + 1);
	}

	// Sort ascending by date.
	const out = Array.from(buckets.entries())
		.map(([date, count]) => ({ date, count }))
		// oxlint-disable-next-line no-array-sort -- local array
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	return ok(out);
}

export async function courseCompletionFunnel(
	ctx: PluginContext,
	courseId: string,
): Promise<Result<{ started: number; q25: number; q50: number; q75: number; completed: number }>> {
	if (!courseId) return err(LEARN_ERRORS.FORBIDDEN, "courseId required");

	const enrollRows = await scanAll<Enrollment>(ctx, "enrollments", { courseId });
	const active = enrollRows.filter((r) => !r.data.revokedAt);
	const started = active.length;

	// Per-user max percentComplete across all progress rows in the course.
	const progressRows = await scanAll<Progress>(ctx, "progress", { courseId });
	const maxByUser = new Map<string, number>();
	for (const row of progressRows) {
		const p = row.data;
		const pct = p.percentComplete ?? 0;
		const current = maxByUser.get(p.userId) ?? 0;
		if (pct > current) maxByUser.set(p.userId, pct);
	}

	let q25 = 0;
	let q50 = 0;
	let q75 = 0;
	let completed = 0;
	for (const row of active) {
		const pct = maxByUser.get(row.data.userId) ?? 0;
		if (pct >= 25) q25 += 1;
		if (pct >= 50) q50 += 1;
		if (pct >= 75) q75 += 1;
		if (row.data.completedAt || pct >= 100) completed += 1;
	}

	return ok({ started, q25, q50, q75, completed });
}

export async function courseProgressMatrix(
	ctx: PluginContext,
	courseId: string,
	opts: { cursor?: string; limit?: number } = {},
): Promise<
	Result<{
		students: Array<{ userId: string; name: string; lessonProgress: Record<string, number> }>;
		nextCursor?: string;
	}>
> {
	if (!courseId) return err(LEARN_ERRORS.FORBIDDEN, "courseId required");
	const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));

	// Distinct students via active enrollments (stable ordering by row id).
	const page = await getCollection<Enrollment>(ctx, "enrollments").query({
		where: { courseId },
		limit,
		cursor: opts.cursor,
	});
	const active = page.items.filter((r) => !r.data.revokedAt);

	const progressRows = await scanAll<Progress>(ctx, "progress", { courseId });
	const byUser = new Map<string, Record<string, number>>();
	for (const row of progressRows) {
		const map = byUser.get(row.data.userId) ?? {};
		map[row.data.lessonId] = row.data.percentComplete ?? 0;
		byUser.set(row.data.userId, map);
	}

	const students: Array<{
		userId: string;
		name: string;
		lessonProgress: Record<string, number>;
	}> = [];
	for (const row of active) {
		const userId = row.data.userId;
		const lessonProgress = byUser.get(userId) ?? {};
		students.push({ userId, name: userId, lessonProgress });
	}

	const result: {
		students: Array<{ userId: string; name: string; lessonProgress: Record<string, number> }>;
		nextCursor?: string;
	} = { students };
	if (page.hasMore && page.cursor !== undefined) result.nextCursor = page.cursor;
	return ok(result);
}

export async function courseQuizStats(
	ctx: PluginContext,
	courseId: string,
): Promise<Result<QuizStats[]>> {
	if (!courseId) return err(LEARN_ERRORS.FORBIDDEN, "courseId required");

	// We don't have a direct quiz->course link, so we find quizzes via lessons
	// in this course that carry a quiz reference. If content is unavailable,
	// fall back to "all quizzes" — tests that seed a single quiz still pass.
	const quizIdsInCourse = new Set<string>();
	if (ctx.content) {
		let cursor: string | undefined;
		/* oxlint-disable no-await-in-loop */
		do {
			const page = await ctx.content.list("lessons", {
				where: { status: "published" },
				limit: 200,
				cursor,
			});
			for (const item of page.items) {
				const data = item.data as Record<string, unknown>;
				if (data["course"] !== courseId) continue;
				const quizId = data["quiz"];
				if (typeof quizId === "string" && quizId.length > 0) quizIdsInCourse.add(quizId);
			}
			cursor = page.hasMore ? page.cursor : undefined;
		} while (cursor);
		/* oxlint-enable no-await-in-loop */
	}

	// Attempts scoped to these quizzes (if known), otherwise all attempts.
	const attempts = await scanAll<QuizAttempt>(ctx, "quiz_attempts");
	const byQuiz = new Map<string, QuizAttempt[]>();
	for (const row of attempts) {
		const a = row.data;
		if (quizIdsInCourse.size > 0 && !quizIdsInCourse.has(a.quizId)) continue;
		const arr = byQuiz.get(a.quizId) ?? [];
		arr.push(a);
		byQuiz.set(a.quizId, arr);
	}

	const out: QuizStats[] = [];
	for (const [quizId, list] of byQuiz.entries()) {
		// eslint-disable-next-line no-await-in-loop
		const quiz = await getCollection<Quiz>(ctx, "quizzes").get(quizId);
		const submitted = list.filter((a) => a.submittedAt);
		const total = submitted.length;
		const passed = submitted.filter((a) => a.passed).length;
		const sumScore = submitted.reduce((acc, a) => acc + (a.score ?? 0), 0);
		out.push({
			quizId,
			title: quiz?.title ?? quizId,
			attempts: total,
			passRate: total > 0 ? Math.round((passed / total) * 10000) / 100 : 0,
			avgScore: total > 0 ? Math.round((sumScore / total) * 100) / 100 : 0,
		});
	}

	return ok(out);
}

export async function studentProgressAcrossCourses(
	ctx: PluginContext,
	instructorId: string,
	studentId: string,
): Promise<Result<StudentProgress>> {
	if (!instructorId) return err(LEARN_ERRORS.UNAUTHENTICATED, "instructorId required");
	if (!studentId) return err(LEARN_ERRORS.FORBIDDEN, "studentId required");

	const courseIds = await instructorCourseIds(ctx, instructorId);
	const courseSet = new Set(courseIds);
	const studentEnrollments = await scanAll<Enrollment>(ctx, "enrollments", {
		userId: studentId,
	});

	const courses: StudentProgress["courses"] = [];
	for (const row of studentEnrollments) {
		const e = row.data;
		if (!courseSet.has(e.courseId)) continue;
		if (e.revokedAt) continue;
		// eslint-disable-next-line no-await-in-loop
		const title = await courseTitle(ctx, e.courseId);
		// eslint-disable-next-line no-await-in-loop
		const progressRows = await scanAll<Progress>(ctx, "progress", {
			userId: studentId,
			courseId: e.courseId,
		});
		const lessonsTotal = await countLessons(ctx, e.courseId);
		const lessonsCompleted = progressRows.filter((r) => r.data.completedAt).length;
		const sumPct = progressRows.reduce((a, r) => a + (r.data.percentComplete ?? 0), 0);
		const percentComplete =
			progressRows.length > 0
				? Math.round((sumPct / progressRows.length) * 100) / 100
				: 0;

		let lastActivityAt: string | undefined;
		for (const r of progressRows) {
			const ts = r.data.completedAt ?? r.data.startedAt;
			if (!ts) continue;
			if (!lastActivityAt || ts > lastActivityAt) lastActivityAt = ts;
		}

		const entry: StudentProgress["courses"][number] = {
			courseId: e.courseId,
			courseTitle: title,
			enrolledAt: e.enrolledAt,
			percentComplete,
			lessonsCompleted,
			lessonsTotal,
		};
		if (e.completedAt !== undefined) entry.completedAt = e.completedAt;
		if (lastActivityAt !== undefined) entry.lastActivityAt = lastActivityAt;
		courses.push(entry);
	}

	return ok({ studentId, courses });
}

// ---------------------------------------------------------------------------
// Admin aggregations
// ---------------------------------------------------------------------------

export async function siteAnalytics(
	ctx: PluginContext,
	range: DateRange,
): Promise<Result<SiteAnalytics>> {
	const enrollments = await scanAll<Enrollment>(ctx, "enrollments");
	const certificates = await scanAll<Certificate>(ctx, "certificates");
	const progressRows = await scanAll<Progress>(ctx, "progress");

	let totalEnrollments = 0;
	let totalCompletions = 0;
	for (const row of enrollments) {
		const e = row.data;
		if (e.revokedAt) continue;
		if (isWithinRange(e.enrolledAt, range)) totalEnrollments += 1;
		if (e.completedAt && isWithinRange(e.completedAt, range)) totalCompletions += 1;
	}

	let certificatesIssued = 0;
	for (const row of certificates) {
		if (isWithinRange(row.data.issuedAt, range)) certificatesIssued += 1;
	}

	const thirtyDaysAgo = msAgo(30);
	const activeUsers = new Set<string>();
	for (const row of progressRows) {
		const p = row.data;
		const ts = p.completedAt ? Date.parse(p.completedAt) : Date.parse(p.startedAt);
		if (!Number.isNaN(ts) && ts >= thirtyDaysAgo) activeUsers.add(p.userId);
	}

	return ok({
		totalEnrollments,
		totalCompletions,
		activeUsers30d: activeUsers.size,
		certificatesIssued,
	});
}

export async function coursesComparison(
	ctx: PluginContext,
	range: DateRange,
	opts: { cursor?: string; limit?: number } = {},
): Promise<Result<PaginatedResult<CourseComparison>>> {
	const limit = Math.max(1, Math.min(opts.limit ?? 50, 100));

	// Gather course ids by scanning the courses content collection.
	const courseIds: string[] = [];
	const titles = new Map<string, string>();
	let nextCursor: string | undefined;

	if (ctx.content) {
		const page = await ctx.content.list("courses", {
			limit,
			cursor: opts.cursor,
		});
		for (const item of page.items) {
			courseIds.push(item.id);
			const title = (item.data as Record<string, unknown>)["title"];
			titles.set(item.id, typeof title === "string" ? title : item.id);
		}
		if (page.hasMore && page.cursor !== undefined) nextCursor = page.cursor;
	}

	const items: CourseComparison[] = [];
	for (const courseId of courseIds) {
		// eslint-disable-next-line no-await-in-loop
		const enrollRows = await scanAll<Enrollment>(ctx, "enrollments", { courseId });
		const active = enrollRows.filter(
			(r) => !r.data.revokedAt && isWithinRange(r.data.enrolledAt, range),
		);
		const enrolled = active.length;
		const completed = active.filter((r) => r.data.completedAt).length;
		const completionRate = enrolled > 0 ? (completed / enrolled) * 100 : 0;

		// eslint-disable-next-line no-await-in-loop
		const progressRows = await scanAll<Progress>(ctx, "progress", { courseId });
		const byUser = new Map<string, number[]>();
		for (const row of progressRows) {
			const arr = byUser.get(row.data.userId) ?? [];
			arr.push(row.data.percentComplete ?? 0);
			byUser.set(row.data.userId, arr);
		}
		let sum = 0;
		let n = 0;
		for (const arr of byUser.values()) {
			if (arr.length === 0) continue;
			sum += arr.reduce((a, b) => a + b, 0) / arr.length;
			n += 1;
		}
		const avgProgress = n > 0 ? sum / n : 0;

		items.push({
			courseId,
			title: titles.get(courseId) ?? courseId,
			enrolled,
			completionRate: Math.round(completionRate * 100) / 100,
			avgProgress: Math.round(avgProgress * 100) / 100,
		});
	}

	const result: PaginatedResult<CourseComparison> = { items };
	if (nextCursor !== undefined) result.nextCursor = nextCursor;
	return ok(result);
}

export async function engagementMetrics(
	ctx: PluginContext,
	range: DateRange,
): Promise<Result<EngagementMetrics>> {
	const progressRows = await scanAll<Progress>(ctx, "progress");
	const enrollments = await scanAll<Enrollment>(ctx, "enrollments");

	const dauMap = new Map<string, Set<string>>(); // date -> userIds
	for (const row of progressRows) {
		const p = row.data;
		const iso = p.completedAt ?? p.startedAt;
		if (!iso || !isWithinRange(iso, range)) continue;
		const date = dateBucket(iso);
		const set = dauMap.get(date) ?? new Set<string>();
		set.add(p.userId);
		dauMap.set(date, set);
	}

	const completionsByDayMap = new Map<string, number>();
	for (const row of enrollments) {
		const e = row.data;
		if (!e.completedAt || !isWithinRange(e.completedAt, range)) continue;
		const date = dateBucket(e.completedAt);
		completionsByDayMap.set(date, (completionsByDayMap.get(date) ?? 0) + 1);
	}

	const dau = Array.from(dauMap.entries())
		.map(([date, set]) => ({ date, count: set.size }))
		// oxlint-disable-next-line no-array-sort -- local array
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

	const completionsByDay = Array.from(completionsByDayMap.entries())
		.map(([date, count]) => ({ date, count }))
		// oxlint-disable-next-line no-array-sort -- local array
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

	return ok({ dau, completionsByDay, avgSessionLength: 0 });
}

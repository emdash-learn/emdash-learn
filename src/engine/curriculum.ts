/**
 * Curriculum engine (T07 / §22 / §6.1).
 *
 * Assembles a user's view of a course's lessons, applying:
 *   - `is_preview` — visible without enrollment.
 *   - enrollment — non-preview lessons require an active enrollment.
 *   - drip — `drip.unlocksAt` against the configured `dripMode` setting.
 *   - `requires_previous` — a lesson with this flag is locked until the
 *     preceding lesson (by `order`) is completed.
 *
 * `forUser` is the read the `curriculum` route calls. `myLearning` produces
 * the cross-course dashboard summary for the `my-learning` route (§6.1).
 */

import type { PluginContext, StorageCollection } from "emdash";

/**
 * Local alias for the content item shape `ctx.content.get` returns. The
 * `emdash` package exports a narrower `ContentItem` type, but the runtime
 * `get` signature returns a wider shape (with `authorId`, `scheduledAt`,
 * etc.) — so we infer from the method to stay in lockstep.
 */
type RuntimeContentItem = NonNullable<
	Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>
>;

import { LEARN_ERRORS, LESSONS_COLLECTION_SLUG } from "../constants.js";
import { settingKey } from "../kv-keys.js";
import type { Enrollment, Progress } from "../types/storage.js";
import { isUnlocked, unlocksAt, type DripMode } from "./drip.js";
import { err, ok, type Result } from "./result.js";

function getCollection<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	const collection = (ctx.storage as Record<string, StorageCollection | undefined>)[name];
	if (!collection) {
		throw new Error(`Plugin storage collection "${name}" is not declared in the descriptor.`);
	}
	return collection as StorageCollection<T>;
}

export interface VisibleLesson {
	id: string;
	title: string;
	order: number;
	summary?: string;
	isPreview: boolean;
	requiresPrevious: boolean;
	dripOffsetDays: number;
	unlocksAt: string;
	unlocked: boolean;
	completed: boolean;
	percentComplete: number;
	videoUrl?: string;
	durationSeconds?: number;
}

async function getDripMode(ctx: PluginContext): Promise<DripMode> {
	const raw = await ctx.kv.get<string>(settingKey("dripMode"));
	return raw === "relative" ? "relative" : "immediate";
}

async function getEnrollment(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<Enrollment | null> {
	const page = await getCollection<Enrollment>(ctx, "enrollments").query({
		where: { userId, courseId },
		limit: 1,
	});
	const row = page.items[0];
	if (!row || row.data.revokedAt) return null;
	return row.data;
}

async function listLessonsForCourse(
	ctx: PluginContext,
	courseId: string,
): Promise<RuntimeContentItem[]> {
	if (!ctx.content) return [];
	const out: RuntimeContentItem[] = [];
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await ctx.content.list(LESSONS_COLLECTION_SLUG, {
			where: { status: "published" },
			limit: 100,
			cursor,
		});
		for (const item of page.items) {
			if (item.data["course"] === courseId) out.push(item);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */

	// oxlint-disable-next-line no-array-sort -- `out` is a local array we own
	return [...out].sort((a, b) => lessonOrder(a) - lessonOrder(b));
}

function lessonOrder(item: RuntimeContentItem): number {
	const v = (item.data as Record<string, unknown>)["order"];
	return typeof v === "number" ? v : 0;
}

function lessonField<T>(item: RuntimeContentItem, key: string): T | undefined {
	return (item.data as Record<string, unknown>)[key] as T | undefined;
}

async function getProgressMap(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<Map<string, Progress>> {
	const out = new Map<string, Progress>();
	const collection = getCollection<Progress>(ctx, "progress");
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await collection.query({
			where: { userId, courseId },
			limit: 100,
			cursor,
		});
		for (const row of page.items) out.set(row.data.lessonId, row.data);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
	return out;
}

export async function forUser(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<Result<VisibleLesson[]>> {
	const lessons = await listLessonsForCourse(ctx, courseId);
	if (lessons.length === 0) return ok([]);

	const enrollment = userId ? await getEnrollment(ctx, userId, courseId) : null;
	const progress = enrollment
		? await getProgressMap(ctx, userId, courseId)
		: new Map<string, Progress>();
	const mode = await getDripMode(ctx);
	const now = new Date();

	const out: VisibleLesson[] = [];
	let previousCompleted = true; // first lesson has no previous

	for (const item of lessons) {
		const isPreview = lessonField<boolean | number>(item, "is_preview");
		const isPreviewBool = isPreview === true || isPreview === 1;
		const requiresPrevious = lessonField<boolean | number>(item, "requires_previous");
		const requiresPreviousBool = requiresPrevious === true || requiresPrevious === 1;
		const dripOffsetDays = lessonField<number>(item, "drip_offset_days") ?? 0;

		const scheduledAt = (item as { scheduledAt?: string | null }).scheduledAt ?? null;
		const lessonForDrip = { dripOffsetDays, scheduledAt };
		const base = enrollment ?? { enrolledAt: now.toISOString() };
		const unlockTime = unlocksAt(base, lessonForDrip, mode);
		const dripUnlocked = enrollment ? isUnlocked(base, lessonForDrip, mode, now) : isPreviewBool;

		// Preview lessons are always visible; non-preview require enrollment.
		const visible = isPreviewBool || enrollment !== null;
		if (!visible) continue;

		const prog = progress.get(item.id);
		const completed = Boolean(prog?.completedAt);
		const unlocked = dripUnlocked && (!requiresPreviousBool || previousCompleted);

		const entry: VisibleLesson = {
			id: item.id,
			title: lessonField<string>(item, "title") ?? "Untitled",
			order: lessonOrder(item),
			isPreview: isPreviewBool,
			requiresPrevious: requiresPreviousBool,
			dripOffsetDays,
			unlocksAt: unlockTime,
			unlocked,
			completed,
			percentComplete: prog?.percentComplete ?? 0,
		};
		const summary = lessonField<string>(item, "summary");
		if (summary !== undefined) entry.summary = summary;
		const videoUrl = lessonField<string>(item, "video_url");
		if (videoUrl !== undefined) entry.videoUrl = videoUrl;
		const durationSeconds = lessonField<number>(item, "duration_seconds");
		if (durationSeconds !== undefined) entry.durationSeconds = durationSeconds;
		out.push(entry);

		previousCompleted = completed;
	}

	return ok(out);
}

/**
 * Load a single lesson's full body if the user is allowed to view it.
 * Preview lessons are open. Non-preview require active enrollment AND an
 * unlocked state (drip + requires_previous).
 */
export async function getLesson(
	ctx: PluginContext,
	userId: string,
	lessonId: string,
): Promise<Result<RuntimeContentItem>> {
	if (!ctx.content) {
		return err(LEARN_ERRORS.SETUP_INCOMPLETE, "content access is not available");
	}
	const item = await ctx.content.get(LESSONS_COLLECTION_SLUG, lessonId);
	if (!item || item.status !== "published") {
		return err(LEARN_ERRORS.LESSON_LOCKED, `Lesson ${lessonId} is not available`);
	}
	const courseId = lessonField<string>(item, "course");
	if (!courseId) {
		return err(LEARN_ERRORS.LESSON_LOCKED, "Lesson has no course reference");
	}

	const isPreview = lessonField<boolean | number>(item, "is_preview");
	const isPreviewBool = isPreview === true || isPreview === 1;

	if (isPreviewBool) return ok(item);

	const enrollment = userId ? await getEnrollment(ctx, userId, courseId) : null;
	if (!enrollment) {
		return err(LEARN_ERRORS.NOT_ENROLLED, `User ${userId} is not enrolled in ${courseId}`);
	}

	// Find the lesson in the user's curriculum to respect gating.
	const curriculum = await forUser(ctx, userId, courseId);
	if (!curriculum.ok) return curriculum as unknown as Result<RuntimeContentItem>;
	const entry = curriculum.data.find((l) => l.id === lessonId);
	if (!entry || !entry.unlocked) {
		return err(LEARN_ERRORS.LESSON_LOCKED, `Lesson ${lessonId} is not unlocked yet`);
	}
	return ok(item);
}

// ---------------------------------------------------------------------------
// my-learning
// ---------------------------------------------------------------------------

export interface MyLearningItem {
	courseId: string;
	courseTitle: string;
	coverImage?: string;
	enrolledAt: string;
	percentComplete: number;
	lastActivityAt?: string;
	nextLesson?: { id: string; title: string };
	completedAt?: string;
}

export interface MyLearningOptions {
	status?: "active" | "completed" | "all";
	cursor?: string;
	limit?: number;
}

export interface MyLearningPage {
	items: MyLearningItem[];
	cursor?: string;
	hasMore: boolean;
}

function enrollmentMatchesStatus(row: Enrollment, status: "active" | "completed" | "all"): boolean {
	if (row.revokedAt) return false;
	if (status === "all") return true;
	if (status === "completed") return Boolean(row.completedAt);
	return !row.completedAt;
}

export async function myLearning(
	ctx: PluginContext,
	userId: string,
	opts: MyLearningOptions = {},
): Promise<Result<MyLearningPage>> {
	const status = opts.status ?? "active";
	const page = await getCollection<Enrollment>(ctx, "enrollments").query({
		where: { userId },
		limit: opts.limit,
		cursor: opts.cursor,
	});

	const items: MyLearningItem[] = [];
	/* oxlint-disable no-await-in-loop */
	for (const row of page.items) {
		if (!enrollmentMatchesStatus(row.data, status)) continue;
		const courseId = row.data.courseId;
		const course = ctx.content ? await ctx.content.get("courses", courseId) : null;
		if (!course) continue;
		const curriculum = await forUser(ctx, userId, courseId);
		const lessons = curriculum.ok ? curriculum.data : [];
		const total = lessons.length;
		const completedCount = lessons.filter((l) => l.completed).length;
		const percent = total > 0 ? Math.round((completedCount / total) * 100) : 0;

		const progressMap = await getProgressMap(ctx, userId, courseId);
		let lastActivityAt: string | undefined;
		for (const p of progressMap.values()) {
			const ts = p.completedAt ?? p.startedAt;
			if (!lastActivityAt || ts > lastActivityAt) lastActivityAt = ts;
		}

		const nextLessonEntry = lessons.find((l) => !l.completed);
		const item: MyLearningItem = {
			courseId,
			courseTitle: ((course.data as Record<string, unknown>)["title"] as string) ?? "Untitled",
			enrolledAt: row.data.enrolledAt,
			percentComplete: percent,
		};
		const cover = (course.data as Record<string, unknown>)["cover_image"];
		if (typeof cover === "string") item.coverImage = cover;
		if (lastActivityAt) item.lastActivityAt = lastActivityAt;
		if (nextLessonEntry) {
			item.nextLesson = { id: nextLessonEntry.id, title: nextLessonEntry.title };
		}
		if (row.data.completedAt) item.completedAt = row.data.completedAt;
		items.push(item);
	}
	/* oxlint-enable no-await-in-loop */

	const out: MyLearningPage = { items, hasMore: page.hasMore };
	if (page.cursor !== undefined) out.cursor = page.cursor;
	return ok(out);
}

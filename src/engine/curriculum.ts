/**
 * Curriculum engine — step-aware (ADR 0001).
 *
 * Assembles a user's view of a course as a two-level tree
 * (Lesson → [Topic]). Topics inherit visibility + drip from the parent
 * lesson; their own gate is `requires_previous` against sibling topics.
 *
 * `forUser` is the read the `curriculum` route calls. `myLearning` produces
 * the cross-course dashboard summary for the `my-learning` route.
 */

import type { PluginContext, StorageCollection } from "emdash";

/**
 * Local alias for the content item shape `ctx.content.get` returns.
 */
type RuntimeContentItem = NonNullable<
	Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>
>;

import { LEARN_ERRORS, LESSONS_COLLECTION_SLUG, TOPICS_COLLECTION_SLUG } from "../constants.js";
import { settingKey } from "../kv-keys.js";
import type { CourseContentIndexRow, Enrollment, StepProgress } from "../types/storage.js";
import { isUnlocked, unlocksAt, type DripMode } from "./drip.js";
import { err, ok, type Result } from "./result.js";

function getCollection<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	const collection = (ctx.storage as Record<string, StorageCollection | undefined>)[name];
	if (!collection) {
		throw new Error(`Plugin storage collection "${name}" is not declared in the descriptor.`);
	}
	return collection as StorageCollection<T>;
}

const STEP_PROGRESS_COLLECTION = "step_progress";

export interface VisibleTopic {
	id: string;
	title: string;
	order: number;
	summary?: string;
	requiresPrevious: boolean;
	unlocked: boolean;
	completed: boolean;
	percentComplete: number;
	videoUrl?: string;
	durationSeconds?: number;
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
	topics: VisibleTopic[];
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

const CONTENT_INDEX_COLLECTION = "course_content_index";

/**
 * Synthesize a `RuntimeContentItem`-compatible object from a projection row so
 * callers that use `contentField` / `contentOrder` continue to work unchanged.
 * Only the subset of fields that the curriculum engine reads is populated; body
 * text is intentionally absent (callers that need body text use `ctx.content.get`).
 */
function indexRowToContentItem(
	stepId: string,
	row: CourseContentIndexRow,
): RuntimeContentItem {
	const data: Record<string, unknown> = {
		course: row.courseId,
		order: row.order,
	};
	if (row.lessonId !== undefined) data["lesson"] = row.lessonId;
	if (row.durationSeconds !== undefined) data["duration_seconds"] = row.durationSeconds;
	if (row.isPreview !== undefined) data["is_preview"] = row.isPreview;
	if (row.requiresPrevious !== undefined) data["requires_previous"] = row.requiresPrevious;
	if (row.dripOffsetDays !== undefined) data["drip_offset_days"] = row.dripOffsetDays;

	return {
		id: stepId,
		type: row.stepType === "lesson" ? LESSONS_COLLECTION_SLUG : TOPICS_COLLECTION_SLUG,
		slug: null,
		status: row.status,
		locale: null,
		data,
		createdAt: row.publishedAt ?? new Date(0).toISOString(),
		updatedAt: row.publishedAt ?? new Date(0).toISOString(),
		publishedAt: row.publishedAt ?? null,
		// Cast: `scheduledAt` is used via a cast in forUser; include it here.
		...(row.scheduledAt !== undefined ? { scheduledAt: row.scheduledAt } : {}),
	} as RuntimeContentItem;
}

async function listLessonsForCourse(
	ctx: PluginContext,
	courseId: string,
): Promise<RuntimeContentItem[]> {
	const store = getCollection<CourseContentIndexRow>(ctx, CONTENT_INDEX_COLLECTION);
	const out: RuntimeContentItem[] = [];
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		// The projection only contains published rows — status filter is implicit.
		const page = await store.query({
			where: { courseId, stepType: "lesson" },
			limit: 100,
			cursor,
		});
		for (const { id, data } of page.items) {
			out.push(indexRowToContentItem(data.stepId, data));
			void id; // row id is not needed; stepId carries identity
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */

	// oxlint-disable-next-line no-array-sort -- `out` is a local array we own
	return [...out].sort((a, b) => contentOrder(a) - contentOrder(b));
}

async function listTopicsForCourse(
	ctx: PluginContext,
	courseId: string,
): Promise<RuntimeContentItem[]> {
	const store = getCollection<CourseContentIndexRow>(ctx, CONTENT_INDEX_COLLECTION);
	const out: RuntimeContentItem[] = [];
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		// The projection only contains published rows — status filter is implicit.
		const page = await store.query({
			where: { courseId, stepType: "topic" },
			limit: 100,
			cursor,
		});
		for (const { id, data } of page.items) {
			out.push(indexRowToContentItem(data.stepId, data));
			void id;
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */

	// oxlint-disable-next-line no-array-sort -- `out` is a local array we own
	return [...out].sort((a, b) => contentOrder(a) - contentOrder(b));
}

function contentOrder(item: RuntimeContentItem): number {
	const v = (item.data as Record<string, unknown>)["order"];
	return typeof v === "number" ? v : 0;
}

function contentField<T>(item: RuntimeContentItem, key: string): T | undefined {
	return (item.data as Record<string, unknown>)[key] as T | undefined;
}

interface ProgressMap {
	lesson: Map<string, StepProgress>;
	topic: Map<string, StepProgress>;
}

async function getProgressMap(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<ProgressMap> {
	const out: ProgressMap = { lesson: new Map(), topic: new Map() };
	const collection = getCollection<StepProgress>(ctx, STEP_PROGRESS_COLLECTION);
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await collection.query({
			where: { userId, courseId },
			limit: 100,
			cursor,
		});
		for (const row of page.items) {
			if (row.data.stepType === "lesson") out.lesson.set(row.data.stepId, row.data);
			else out.topic.set(row.data.stepId, row.data);
		}
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
		: { lesson: new Map<string, StepProgress>(), topic: new Map<string, StepProgress>() };
	const allTopics = await listTopicsForCourse(ctx, courseId);
	const topicsByLesson = new Map<string, RuntimeContentItem[]>();
	for (const t of allTopics) {
		const lessonId = contentField<string>(t, "lesson");
		if (!lessonId) continue;
		const list = topicsByLesson.get(lessonId);
		if (list) list.push(t);
		else topicsByLesson.set(lessonId, [t]);
	}
	const mode = await getDripMode(ctx);
	const now = new Date();

	const out: VisibleLesson[] = [];
	let previousCompleted = true; // first lesson has no previous

	for (const item of lessons) {
		const isPreview = contentField<boolean | number>(item, "is_preview");
		const isPreviewBool = isPreview === true || isPreview === 1;
		const requiresPrevious = contentField<boolean | number>(item, "requires_previous");
		const requiresPreviousBool = requiresPrevious === true || requiresPrevious === 1;
		const dripOffsetDays = contentField<number>(item, "drip_offset_days") ?? 0;

		const scheduledAt = (item as { scheduledAt?: string | null }).scheduledAt ?? null;
		const lessonForDrip = { dripOffsetDays, scheduledAt };
		const base = enrollment ?? { enrolledAt: now.toISOString() };
		const unlockTime = unlocksAt(base, lessonForDrip, mode);
		const dripUnlocked = enrollment ? isUnlocked(base, lessonForDrip, mode, now) : isPreviewBool;

		// Preview lessons are always visible; non-preview require enrollment.
		const visible = isPreviewBool || enrollment !== null;
		if (!visible) continue;

		const prog = progress.lesson.get(item.id);
		const completed = Boolean(prog?.completedAt);
		const unlocked = dripUnlocked && (!requiresPreviousBool || previousCompleted);

		// Build topic list under this lesson. `slice()` makes a local copy.
		const rawTopics = topicsByLesson.get(item.id) ?? [];
		const lessonTopicsArr = rawTopics.slice();
		// oxlint-disable-next-line no-array-sort -- `lessonTopicsArr` is a local copy
		lessonTopicsArr.sort((a, b) => contentOrder(a) - contentOrder(b));
		const lessonTopics = lessonTopicsArr;
		const visibleTopics: VisibleTopic[] = [];
		let prevTopicCompleted = true;
		for (const topicItem of lessonTopics) {
			const topicProg = progress.topic.get(topicItem.id);
			const topicCompleted = Boolean(topicProg?.completedAt);
			const topicRequiresPrev = contentField<boolean | number>(topicItem, "requires_previous");
			const topicRequiresPrevBool = topicRequiresPrev === true || topicRequiresPrev === 1;
			const topicUnlocked = unlocked && (!topicRequiresPrevBool || prevTopicCompleted);
			const topicEntry: VisibleTopic = {
				id: topicItem.id,
				title: contentField<string>(topicItem, "title") ?? "Untitled",
				order: contentOrder(topicItem),
				requiresPrevious: topicRequiresPrevBool,
				unlocked: topicUnlocked,
				completed: topicCompleted,
				percentComplete: topicProg?.percentComplete ?? 0,
			};
			const tSummary = contentField<string>(topicItem, "summary");
			if (tSummary !== undefined) topicEntry.summary = tSummary;
			const tVideo = contentField<string>(topicItem, "video_url");
			if (tVideo !== undefined) topicEntry.videoUrl = tVideo;
			const tDur = contentField<number>(topicItem, "duration_seconds");
			if (tDur !== undefined) topicEntry.durationSeconds = tDur;
			visibleTopics.push(topicEntry);
			prevTopicCompleted = topicCompleted;
		}

		const entry: VisibleLesson = {
			id: item.id,
			title: contentField<string>(item, "title") ?? "Untitled",
			order: contentOrder(item),
			isPreview: isPreviewBool,
			requiresPrevious: requiresPreviousBool,
			dripOffsetDays,
			unlocksAt: unlockTime,
			unlocked,
			completed,
			percentComplete: prog?.percentComplete ?? 0,
			topics: visibleTopics,
		};
		const summary = contentField<string>(item, "summary");
		if (summary !== undefined) entry.summary = summary;
		const videoUrl = contentField<string>(item, "video_url");
		if (videoUrl !== undefined) entry.videoUrl = videoUrl;
		const durationSeconds = contentField<number>(item, "duration_seconds");
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
	const courseId = contentField<string>(item, "course");
	if (!courseId) {
		return err(LEARN_ERRORS.LESSON_LOCKED, "Lesson has no course reference");
	}

	const isPreview = contentField<boolean | number>(item, "is_preview");
	const isPreviewBool = isPreview === true || isPreview === 1;

	if (isPreviewBool) return ok(item);

	const enrollment = userId ? await getEnrollment(ctx, userId, courseId) : null;
	if (!enrollment) {
		return err(LEARN_ERRORS.NOT_ENROLLED, `User ${userId} is not enrolled in ${courseId}`);
	}

	const curriculum = await forUser(ctx, userId, courseId);
	if (!curriculum.ok) return curriculum as unknown as Result<RuntimeContentItem>;
	const entry = curriculum.data.find((l) => l.id === lessonId);
	if (!entry || !entry.unlocked) {
		return err(LEARN_ERRORS.LESSON_LOCKED, `Lesson ${lessonId} is not unlocked yet`);
	}
	return ok(item);
}

/**
 * Load a single topic's full body, gated on enrollment + parent-lesson
 * visibility + topic unlocked state. Topics inside preview lessons still
 * require enrollment per ADR 0001.
 */
export async function getTopic(
	ctx: PluginContext,
	userId: string,
	topicId: string,
): Promise<Result<RuntimeContentItem>> {
	if (!ctx.content) {
		return err(LEARN_ERRORS.SETUP_INCOMPLETE, "content access is not available");
	}
	const item = await ctx.content.get(TOPICS_COLLECTION_SLUG, topicId);
	if (!item || item.status !== "published") {
		return err(LEARN_ERRORS.TOPIC_LOCKED, `Topic ${topicId} is not available`);
	}
	const courseId = contentField<string>(item, "course");
	const lessonId = contentField<string>(item, "lesson");
	if (!courseId || !lessonId) {
		return err(LEARN_ERRORS.TOPIC_LOCKED, "Topic is missing course or lesson reference");
	}

	const enrollment = userId ? await getEnrollment(ctx, userId, courseId) : null;
	if (!enrollment) {
		return err(LEARN_ERRORS.NOT_ENROLLED, `User ${userId} is not enrolled in ${courseId}`);
	}

	const curriculum = await forUser(ctx, userId, courseId);
	if (!curriculum.ok) return curriculum as unknown as Result<RuntimeContentItem>;
	const lessonEntry = curriculum.data.find((l) => l.id === lessonId);
	if (!lessonEntry) {
		return err(LEARN_ERRORS.TOPIC_LOCKED, `Parent lesson ${lessonId} is not visible`);
	}
	const topicEntry = lessonEntry.topics.find((t) => t.id === topicId);
	if (!topicEntry || !topicEntry.unlocked) {
		return err(LEARN_ERRORS.TOPIC_LOCKED, `Topic ${topicId} is not unlocked yet`);
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
	nextStep?: { type: "lesson" | "topic"; id: string; title: string; lessonId?: string };
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

		// Count every published step (lesson body + topics) as 1 unit.
		let totalSteps = 0;
		let completedSteps = 0;
		for (const l of lessons) {
			totalSteps += 1;
			if (l.completed) completedSteps += 1;
			for (const t of l.topics) {
				totalSteps += 1;
				if (t.completed) completedSteps += 1;
			}
		}
		const percent = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

		const progressMap = await getProgressMap(ctx, userId, courseId);
		let lastActivityAt: string | undefined;
		for (const map of [progressMap.lesson, progressMap.topic]) {
			for (const p of map.values()) {
				const ts = p.completedAt ?? p.startedAt;
				if (!lastActivityAt || ts > lastActivityAt) lastActivityAt = ts;
			}
		}

		// Next step: walk the tree in order; first non-complete unlocked step.
		let nextStep: MyLearningItem["nextStep"];
		outer: for (const l of lessons) {
			if (!l.completed && l.unlocked) {
				nextStep = { type: "lesson", id: l.id, title: l.title };
				break;
			}
			for (const t of l.topics) {
				if (!t.completed && t.unlocked) {
					nextStep = { type: "topic", id: t.id, title: t.title, lessonId: l.id };
					break outer;
				}
			}
		}

		const item: MyLearningItem = {
			courseId,
			courseTitle: ((course.data as Record<string, unknown>)["title"] as string) ?? "Untitled",
			enrolledAt: row.data.enrolledAt,
			percentComplete: percent,
		};
		const cover = (course.data as Record<string, unknown>)["cover_image"];
		if (typeof cover === "string") item.coverImage = cover;
		if (lastActivityAt) item.lastActivityAt = lastActivityAt;
		if (nextStep) item.nextStep = nextStep;
		if (row.data.completedAt) item.completedAt = row.data.completedAt;
		items.push(item);
	}
	/* oxlint-enable no-await-in-loop */

	const out: MyLearningPage = { items, hasMore: page.hasMore };
	if (page.cursor !== undefined) out.cursor = page.cursor;
	return ok(out);
}

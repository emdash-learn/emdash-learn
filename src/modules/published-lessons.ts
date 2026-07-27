import { PluginRouteError, type PluginContext, type StorageCollection } from "emdash";

import { COURSES_COLLECTION_SLUG, LEARN_ERRORS, LESSONS_COLLECTION_SLUG } from "../constants.js";
import type { CourseContentIndexRow } from "../types/storage.js";
import {
	isPublishedCourseContent,
	optionalPublishedNumber,
	optionalPublishedString,
	publishedSeo,
	requireContent,
	type PublishedSeo,
	type RuntimeContentItem,
} from "./published-content.js";

const MAX_PROJECTION_PAGES = 100;

type ProjectionPage = Awaited<ReturnType<StorageCollection["query"]>>;
type ProjectionRecord = ProjectionPage["items"][number];
type ProjectionQueryOptions = NonNullable<Parameters<StorageCollection["query"]>[0]>;
type ProjectionWhere = NonNullable<ProjectionQueryOptions["where"]>;

export interface PublishedLessonSummary {
	id: string;
	slug: string | null;
	title: string;
	order: number;
	summary?: string;
	videoUrl?: string;
	durationSeconds?: number;
	publishedAt: string | null;
}

export interface PublishedLesson extends PublishedLessonSummary {
	courseId: string;
	body?: unknown;
	locale: string | null;
	seo?: PublishedSeo;
	updatedAt: string;
}

export interface IndexedPublishedLesson {
	status: "indexed";
	lessonId: string;
	courseId: string;
	removedPointers: number;
}

export interface RemovedPublishedLesson {
	status: "removed";
	lessonId: string;
	removedPointers: number;
}

export type PublishedLessonDiagnosticCode =
	| "LESSON_ID_INVALID"
	| "LESSON_ID_MISMATCH"
	| "LESSON_COURSE_ID_INVALID"
	| "LESSON_TITLE_BLANK"
	| "LESSON_ORDER_INVALID";

export interface PublishedLessonDiagnostic {
	code: PublishedLessonDiagnosticCode;
	field: "id" | "course" | "title" | "order";
	message: string;
}

export interface OmittedPublishedLesson {
	status: "omitted";
	lessonId: string;
	removedPointers: number;
	diagnostics: PublishedLessonDiagnostic[];
}

export type PublishedLessonSynchronization =
	IndexedPublishedLesson | RemovedPublishedLesson | OmittedPublishedLesson;

interface CanonicalPublishedLesson {
	item: RuntimeContentItem;
	courseId: string;
	title: string;
	order: number;
}

function requireProjection(ctx: PluginContext): StorageCollection {
	const projection = ctx.storage["course_content_index"];
	if (projection) return projection;
	throw new PluginRouteError(
		LEARN_ERRORS.SETUP_INCOMPLETE,
		"The course content index is unavailable. Complete Learn setup before using its public routes.",
		409,
	);
}

function isCourseContentIndexRow(value: unknown): value is CourseContentIndexRow {
	if (typeof value !== "object" || value === null) return false;
	const courseId = Reflect.get(value, "courseId");
	const stepType = Reflect.get(value, "stepType");
	const stepId = Reflect.get(value, "stepId");
	const order = Reflect.get(value, "order");
	const status = Reflect.get(value, "status");
	return (
		typeof courseId === "string" &&
		courseId.trim().length > 0 &&
		stepType === "lesson" &&
		typeof stepId === "string" &&
		stepId.trim().length > 0 &&
		typeof order === "number" &&
		Number.isSafeInteger(order) &&
		order >= 0 &&
		status === "published"
	);
}

function interpretPublishedLesson(
	item: RuntimeContentItem,
	expectedLessonId: string,
): {
	lesson: CanonicalPublishedLesson | null;
	diagnostics: PublishedLessonDiagnostic[];
} {
	const diagnostics: PublishedLessonDiagnostic[] = [];
	const data =
		typeof item.data === "object" && item.data !== null ? item.data : Object.create(null);
	const courseId = Reflect.get(data, "course");
	const title = Reflect.get(data, "title");
	const order = Reflect.get(data, "order");
	const hasValidId = typeof item.id === "string" && item.id.trim().length > 0;
	const hasExpectedId = hasValidId && item.id === expectedLessonId;
	const hasValidCourseId = typeof courseId === "string" && courseId.trim().length > 0;
	const hasValidTitle = typeof title === "string" && title.trim().length > 0;
	const hasValidOrder = typeof order === "number" && Number.isSafeInteger(order) && order >= 0;

	if (!hasValidId) {
		diagnostics.push({
			code: "LESSON_ID_INVALID",
			field: "id",
			message: "Published Lesson ID must not be blank.",
		});
	} else if (!hasExpectedId) {
		diagnostics.push({
			code: "LESSON_ID_MISMATCH",
			field: "id",
			message: "Published Lesson ID does not match the requested Lesson.",
		});
	}
	if (!hasValidCourseId) {
		diagnostics.push({
			code: "LESSON_COURSE_ID_INVALID",
			field: "course",
			message: "Published Lesson Course reference must not be blank.",
		});
	}
	if (!hasValidTitle) {
		diagnostics.push({
			code: "LESSON_TITLE_BLANK",
			field: "title",
			message: "Published Lesson title must not be blank.",
		});
	}
	if (!hasValidOrder) {
		diagnostics.push({
			code: "LESSON_ORDER_INVALID",
			field: "order",
			message: "Published Lesson order must be a nonnegative integer.",
		});
	}

	if (diagnostics.length > 0 || !hasValidCourseId || !hasValidTitle || !hasValidOrder) {
		return { lesson: null, diagnostics };
	}
	return {
		lesson: {
			item,
			courseId,
			title,
			order,
		},
		diagnostics,
	};
}

function reportMalformedPublishedLesson(
	ctx: PluginContext,
	lessonId: string,
	diagnostics: PublishedLessonDiagnostic[],
): void {
	ctx.log.warn("Malformed Published Lesson omitted.", { lessonId, diagnostics });
}

function toPublishedLessonSummary(lesson: CanonicalPublishedLesson): PublishedLessonSummary {
	const summary: PublishedLessonSummary = {
		id: lesson.item.id,
		slug: lesson.item.slug,
		title: lesson.title,
		order: lesson.order,
		publishedAt: lesson.item.publishedAt,
	};
	const publicSummary = optionalPublishedString(lesson.item.data, "summary");
	if (publicSummary !== undefined) summary.summary = publicSummary;
	const videoUrl = optionalPublishedString(lesson.item.data, "video_url");
	if (videoUrl !== undefined) summary.videoUrl = videoUrl;
	const durationSeconds = optionalPublishedNumber(lesson.item.data, "duration_seconds");
	if (durationSeconds !== undefined) summary.durationSeconds = durationSeconds;
	return summary;
}

function toPublishedLesson(lesson: CanonicalPublishedLesson): PublishedLesson {
	const publishedLesson: PublishedLesson = {
		...toPublishedLessonSummary(lesson),
		courseId: lesson.courseId,
		locale: lesson.item.locale,
		updatedAt: lesson.item.updatedAt,
	};
	if (Object.hasOwn(lesson.item.data, "body")) {
		publishedLesson.body = lesson.item.data["body"];
	}
	const seo = publishedSeo(lesson.item.seo);
	if (seo !== undefined) publishedLesson.seo = seo;
	return publishedLesson;
}

async function readProjectionRecords(
	projection: StorageCollection,
	where: ProjectionWhere,
): Promise<ProjectionRecord[]> {
	const records: ProjectionRecord[] = [];
	let cursor: string | undefined;
	let pagesRead = 0;

	/* oxlint-disable no-await-in-loop -- storage pagination is sequential */
	do {
		pagesRead += 1;
		const page = await projection.query({
			where,
			limit: 100,
			cursor,
		});
		records.push(...page.items);
		if (page.hasMore && !page.cursor) {
			throw new PluginRouteError(
				"LEARN_INDEX_PAGINATION_INVALID",
				"Published Lesson projection pagination could not continue deterministically.",
				503,
			);
		}
		if (page.hasMore && pagesRead >= MAX_PROJECTION_PAGES) {
			throw new PluginRouteError(
				"LEARN_CONTENT_SCALE_LIMIT",
				`Published Lesson projection scans are limited to ${MAX_PROJECTION_PAGES} pages.`,
				503,
			);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */

	return records;
}

async function projectedRows(
	projection: StorageCollection,
	where: ProjectionWhere,
	matches: (row: CourseContentIndexRow) => boolean,
): Promise<CourseContentIndexRow[]> {
	const rows: CourseContentIndexRow[] = [];
	for (const record of await readProjectionRecords(projection, where)) {
		if (isCourseContentIndexRow(record.data) && matches(record.data)) rows.push(record.data);
	}
	return rows;
}

export function contentIndexId(courseId: string, lessonId: string): string {
	return `idx__${courseId}__lesson__${lessonId}`;
}

async function removePublishedLessonPointers(
	projection: StorageCollection,
	lessonId: string,
): Promise<number> {
	const pointerIds = (
		await readProjectionRecords(projection, {
			stepType: "lesson",
			stepId: lessonId,
		})
	).map((record) => record.id);

	let removedPointers = 0;
	/* oxlint-disable no-await-in-loop -- pointer removals are intentionally completed before replacement */
	for (const pointerId of pointerIds) {
		const removed = await projection.delete(pointerId);
		if (!removed) {
			throw new PluginRouteError(
				"LEARN_INDEX_REMOVE_FAILED",
				`Published Lesson projection pointer "${pointerId}" could not be removed.`,
				503,
			);
		}
		removedPointers += 1;
	}
	/* oxlint-enable no-await-in-loop */

	return removedPointers;
}

export async function synchronizePublishedLesson(
	ctx: PluginContext,
	lessonId: string,
): Promise<PublishedLessonSynchronization> {
	const content = requireContent(ctx);
	const projection = requireProjection(ctx);
	const item = await content.get(LESSONS_COLLECTION_SLUG, lessonId);
	const interpreted =
		item?.status === "published"
			? interpretPublishedLesson(item, lessonId)
			: { lesson: null, diagnostics: [] };
	const removedPointers = await removePublishedLessonPointers(projection, lessonId);

	if (interpreted.diagnostics.length > 0) {
		reportMalformedPublishedLesson(ctx, lessonId, interpreted.diagnostics);
		return {
			status: "omitted",
			lessonId,
			removedPointers,
			diagnostics: interpreted.diagnostics,
		};
	}

	if (!interpreted.lesson) {
		return { status: "removed", lessonId, removedPointers };
	}

	const lesson = interpreted.lesson;
	const row: CourseContentIndexRow = {
		courseId: lesson.courseId,
		stepType: "lesson",
		stepId: lesson.item.id,
		order: lesson.order,
		status: "published",
	};
	await projection.put(contentIndexId(lesson.courseId, lesson.item.id), row);
	return {
		status: "indexed",
		lessonId: lesson.item.id,
		courseId: lesson.courseId,
		removedPointers,
	};
}

export async function listPublishedLessonsByCourse(
	ctx: PluginContext,
	courseId: string,
): Promise<PublishedLessonSummary[]> {
	const content = requireContent(ctx);
	const course = await content.get(COURSES_COLLECTION_SLUG, courseId);
	if (!course || !isPublishedCourseContent(course, courseId)) return [];

	const rows = await projectedRows(
		requireProjection(ctx),
		{ courseId, stepType: "lesson" },
		(row) => row.courseId === courseId,
	);
	const lessons: PublishedLessonSummary[] = [];
	const seen = new Set<string>();

	/* oxlint-disable no-await-in-loop -- authoritative Lesson rereads are intentionally bounded */
	for (const row of rows) {
		if (seen.has(row.stepId)) continue;
		seen.add(row.stepId);
		const item = await content.get(LESSONS_COLLECTION_SLUG, row.stepId);
		if (!item || item.status !== "published") continue;
		const interpreted = interpretPublishedLesson(item, row.stepId);
		if (interpreted.diagnostics.length > 0) {
			reportMalformedPublishedLesson(ctx, row.stepId, interpreted.diagnostics);
			continue;
		}
		if (!interpreted.lesson || interpreted.lesson.courseId !== courseId) continue;
		lessons.push(toPublishedLessonSummary(interpreted.lesson));
	}
	/* oxlint-enable no-await-in-loop */

	// oxlint-disable-next-line no-array-sort -- sorting a local copy for deterministic Lesson order
	return lessons.sort((left, right) => {
		const byOrder = left.order - right.order;
		return byOrder === 0 ? left.id.localeCompare(right.id) : byOrder;
	});
}

export async function resolvePublishedLesson(
	ctx: PluginContext,
	lessonId: string,
): Promise<PublishedLesson | null> {
	const content = requireContent(ctx);
	const item = await content.get(LESSONS_COLLECTION_SLUG, lessonId);
	if (!item || item.status !== "published") return null;
	const interpreted = interpretPublishedLesson(item, lessonId);
	if (interpreted.diagnostics.length > 0) {
		reportMalformedPublishedLesson(ctx, lessonId, interpreted.diagnostics);
		return null;
	}
	if (!interpreted.lesson) return null;

	const course = await content.get(COURSES_COLLECTION_SLUG, interpreted.lesson.courseId);
	if (!course || !isPublishedCourseContent(course, interpreted.lesson.courseId)) return null;

	const projectionRows = await projectedRows(
		requireProjection(ctx),
		{ stepType: "lesson", stepId: lessonId },
		(row) => row.stepId === lessonId,
	);
	const hasCurrentPointer = projectionRows.some(
		(row) => row.courseId === interpreted.lesson?.courseId,
	);
	if (!hasCurrentPointer) return null;
	return toPublishedLesson(interpreted.lesson);
}

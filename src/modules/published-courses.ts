import { PluginRouteError, type PluginContext, type StorageCollection } from "emdash";

import { COURSES_COLLECTION_SLUG, LEARN_ERRORS, LESSONS_COLLECTION_SLUG } from "../constants.js";
import type { CourseContentIndexRow } from "../types/storage.js";

const MAX_SOURCE_PAGES = 100;

type RuntimeContentItem = NonNullable<
	Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>
>;

export type PublishedCourseDifficulty = "beginner" | "intermediate" | "advanced";

export interface PublishedSeo {
	title: string | null;
	description: string | null;
	image: string | null;
	canonical: string | null;
	noIndex: boolean;
}

export interface PublishedCourseImage {
	id: string;
	provider?: string;
	src?: string;
	previewUrl?: string;
	alt?: string;
	width?: number;
	height?: number;
}

export interface PublishedCourseSummary {
	id: string;
	slug: string | null;
	title: string;
	subtitle?: string;
	description?: string;
	coverImage?: PublishedCourseImage;
	difficulty?: PublishedCourseDifficulty;
	estimatedHours?: number;
	publishedAt: string | null;
}

export interface PublishedCourseCatalogInput {
	cursor?: string;
	limit?: number;
	search?: string;
	difficulty?: PublishedCourseDifficulty;
}

export interface PublishedCourseCatalogPage {
	items: PublishedCourseSummary[];
	cursor?: string;
	hasMore: boolean;
}

export interface PublishedCourse extends PublishedCourseSummary {
	body?: unknown;
	locale: string | null;
	seo?: PublishedSeo;
	updatedAt: string;
}

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

export interface PublishedCourseDetail {
	course: PublishedCourse;
	lessons: PublishedLessonSummary[];
}

export interface PublishedCourseLookup {
	courseId?: string;
	slug?: string;
}

function requireContent(ctx: PluginContext): NonNullable<PluginContext["content"]> {
	if (ctx.content) return ctx.content;
	throw new PluginRouteError(
		LEARN_ERRORS.SETUP_INCOMPLETE,
		"Content access is unavailable. Configure the Learn content collections before using its public routes.",
		409,
	);
}

function requireContentIndex(ctx: PluginContext): StorageCollection {
	const collection = ctx.storage["course_content_index"];
	if (collection) return collection;
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
		courseId.length > 0 &&
		stepType === "lesson" &&
		typeof stepId === "string" &&
		stepId.length > 0 &&
		typeof order === "number" &&
		Number.isSafeInteger(order) &&
		order >= 0 &&
		status === "published"
	);
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(data: Record<string, unknown>, key: string): number | undefined {
	const value = data[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeIntegerField(data: Record<string, unknown>, key: string): number | undefined {
	const value = data[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function difficultyField(value: unknown): PublishedCourseDifficulty | undefined {
	if (value === "beginner" || value === "intermediate" || value === "advanced") return value;
	return undefined;
}

function imageField(value: unknown): PublishedCourseImage | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const id = Reflect.get(value, "id");
	if (typeof id !== "string" || id.length === 0) return undefined;

	const image: PublishedCourseImage = { id };
	const provider = Reflect.get(value, "provider");
	if (typeof provider === "string" && provider.length > 0) image.provider = provider;
	const src = Reflect.get(value, "src");
	if (typeof src === "string" && src.length > 0) image.src = src;
	const previewUrl = Reflect.get(value, "previewUrl");
	if (typeof previewUrl === "string" && previewUrl.length > 0) image.previewUrl = previewUrl;
	const alt = Reflect.get(value, "alt");
	if (typeof alt === "string") image.alt = alt;
	const width = Reflect.get(value, "width");
	if (typeof width === "number" && Number.isFinite(width)) image.width = width;
	const height = Reflect.get(value, "height");
	if (typeof height === "number" && Number.isFinite(height)) image.height = height;
	return image;
}

function nullableStringField(value: unknown, key: string): string | null | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const field = Reflect.get(value, key);
	return typeof field === "string" || field === null ? field : undefined;
}

function seoField(value: unknown): PublishedSeo | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const title = nullableStringField(value, "title");
	const description = nullableStringField(value, "description");
	const image = nullableStringField(value, "image");
	const canonical = nullableStringField(value, "canonical");
	const noIndex = Reflect.get(value, "noIndex");
	if (
		title === undefined ||
		description === undefined ||
		image === undefined ||
		canonical === undefined ||
		typeof noIndex !== "boolean"
	) {
		return undefined;
	}
	return { title, description, image, canonical, noIndex };
}

function hasPublishedBase(item: RuntimeContentItem): boolean {
	return (
		item.status === "published" &&
		typeof item.id === "string" &&
		item.id.length > 0 &&
		(item.slug === null || typeof item.slug === "string") &&
		(item.locale === null || typeof item.locale === "string") &&
		typeof item.data === "object" &&
		item.data !== null &&
		typeof item.updatedAt === "string" &&
		item.updatedAt.length > 0 &&
		typeof item.publishedAt === "string" &&
		item.publishedAt.length > 0
	);
}

function isPublishedCourseContent(item: RuntimeContentItem): boolean {
	return hasPublishedBase(item) && stringField(item.data, "title") !== undefined;
}

function isPublishedLessonContent(item: RuntimeContentItem): boolean {
	return (
		hasPublishedBase(item) &&
		stringField(item.data, "title") !== undefined &&
		stringField(item.data, "course") !== undefined &&
		nonNegativeIntegerField(item.data, "order") !== undefined
	);
}

function toCourseSummary(item: RuntimeContentItem): PublishedCourseSummary {
	const summary: PublishedCourseSummary = {
		id: item.id,
		slug: item.slug,
		title: stringField(item.data, "title") ?? "",
		publishedAt: item.publishedAt,
	};
	const subtitle = stringField(item.data, "subtitle");
	if (subtitle !== undefined) summary.subtitle = subtitle;
	const description = stringField(item.data, "description");
	if (description !== undefined) summary.description = description;
	const coverImage = imageField(item.data["cover_image"]);
	if (coverImage !== undefined) summary.coverImage = coverImage;
	const difficulty = difficultyField(item.data["difficulty"]);
	if (difficulty !== undefined) summary.difficulty = difficulty;
	const estimatedHours = numberField(item.data, "estimated_hours");
	if (estimatedHours !== undefined) summary.estimatedHours = estimatedHours;
	return summary;
}

function toPublishedCourse(item: RuntimeContentItem): PublishedCourse {
	const course: PublishedCourse = {
		...toCourseSummary(item),
		locale: item.locale,
		updatedAt: item.updatedAt,
	};
	if (Object.hasOwn(item.data, "body")) course.body = item.data["body"];
	const seo = seoField(item.seo);
	if (seo !== undefined) course.seo = seo;
	return course;
}

function toLessonSummary(item: RuntimeContentItem): PublishedLessonSummary {
	const lesson: PublishedLessonSummary = {
		id: item.id,
		slug: item.slug,
		title: stringField(item.data, "title") ?? "",
		order: nonNegativeIntegerField(item.data, "order") ?? 0,
		publishedAt: item.publishedAt,
	};
	const summary = stringField(item.data, "summary");
	if (summary !== undefined) lesson.summary = summary;
	const videoUrl = stringField(item.data, "video_url");
	if (videoUrl !== undefined) lesson.videoUrl = videoUrl;
	const durationSeconds = numberField(item.data, "duration_seconds");
	if (durationSeconds !== undefined) lesson.durationSeconds = durationSeconds;
	return lesson;
}

function toPublishedLesson(item: RuntimeContentItem, courseId: string): PublishedLesson {
	const lesson: PublishedLesson = {
		...toLessonSummary(item),
		courseId,
		locale: item.locale,
		updatedAt: item.updatedAt,
	};
	if (Object.hasOwn(item.data, "body")) lesson.body = item.data["body"];
	const seo = seoField(item.seo);
	if (seo !== undefined) lesson.seo = seo;
	return lesson;
}

async function allPublishedCourses(ctx: PluginContext): Promise<RuntimeContentItem[]> {
	const content = requireContent(ctx);
	const items: RuntimeContentItem[] = [];
	let cursor: string | undefined;
	let pagesRead = 0;

	/* oxlint-disable no-await-in-loop */
	do {
		pagesRead += 1;
		const page = await content.list(COURSES_COLLECTION_SLUG, {
			where: { status: "published" },
			orderBy: { createdAt: "asc" },
			limit: 100,
			cursor,
		});
		for (const item of page.items) {
			if (isPublishedCourseContent(item)) items.push(item);
		}
		if (page.hasMore && !page.cursor) {
			throw new PluginRouteError(
				"LEARN_CONTENT_PAGINATION_INVALID",
				"Published Course pagination could not continue deterministically.",
				503,
			);
		}
		if (page.hasMore && pagesRead >= MAX_SOURCE_PAGES) {
			throw new PluginRouteError(
				"LEARN_CONTENT_SCALE_LIMIT",
				`Published Course scans are limited to ${MAX_SOURCE_PAGES} source pages.`,
				503,
			);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */

	return items;
}

function decodeOffset(cursor: string | undefined): number {
	if (!cursor) return 0;
	try {
		const parsed: unknown = JSON.parse(atob(cursor));
		const offset =
			typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "offset") : undefined;
		if (typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0) {
			return offset;
		}
	} catch {
		// The stable public error below deliberately hides parser details.
	}
	throw new PluginRouteError("LEARN_CATALOG_CURSOR_INVALID", "The catalog cursor is invalid.", 400);
}

function encodeOffset(offset: number): string {
	return btoa(JSON.stringify({ offset }));
}

export async function listPublishedCourses(
	ctx: PluginContext,
	input: PublishedCourseCatalogInput,
): Promise<PublishedCourseCatalogPage> {
	const search = input.search?.trim().toLocaleLowerCase();
	const filteredCourses = (await allPublishedCourses(ctx)).map(toCourseSummary).filter((course) => {
		if (input.difficulty !== undefined && course.difficulty !== input.difficulty) return false;
		if (!search) return true;
		const haystack = [course.title, course.subtitle, course.description]
			.filter((part): part is string => part !== undefined)
			.join("\n")
			.toLocaleLowerCase();
		return haystack.includes(search);
	});
	// oxlint-disable-next-line no-array-sort -- sorting a local copy for deterministic pagination
	const courses = [...filteredCourses].sort((left, right) => {
		const byTitle = left.title.localeCompare(right.title);
		return byTitle === 0 ? left.id.localeCompare(right.id) : byTitle;
	});

	const limit = input.limit ?? 20;
	const offset = decodeOffset(input.cursor);
	const items = courses.slice(offset, offset + limit);
	const nextOffset = offset + items.length;
	const hasMore = nextOffset < courses.length;
	const page: PublishedCourseCatalogPage = { items, hasMore };
	if (hasMore) page.cursor = encodeOffset(nextOffset);
	return page;
}

async function findPublishedCourse(
	ctx: PluginContext,
	lookup: PublishedCourseLookup,
): Promise<RuntimeContentItem | null> {
	const content = requireContent(ctx);
	if (lookup.courseId) {
		const item = await content.get(COURSES_COLLECTION_SLUG, lookup.courseId);
		return item && isPublishedCourseContent(item) ? item : null;
	}
	if (!lookup.slug) return null;
	const items = await allPublishedCourses(ctx);
	return items.find((item) => item.slug === lookup.slug) ?? null;
}

async function publishedLessonSummaries(
	ctx: PluginContext,
	courseId: string,
): Promise<PublishedLessonSummary[]> {
	const content = requireContent(ctx);
	const index = requireContentIndex(ctx);
	const rows: CourseContentIndexRow[] = [];
	let cursor: string | undefined;
	let pagesRead = 0;

	/* oxlint-disable no-await-in-loop */
	do {
		pagesRead += 1;
		const page = await index.query({
			where: { courseId, stepType: "lesson" },
			limit: 100,
			cursor,
		});
		for (const row of page.items) {
			if (isCourseContentIndexRow(row.data) && row.data.status === "published") {
				rows.push(row.data);
			}
		}
		if (page.hasMore && !page.cursor) {
			throw new PluginRouteError(
				"LEARN_INDEX_PAGINATION_INVALID",
				"Published Lesson projection pagination could not continue deterministically.",
				503,
			);
		}
		if (page.hasMore && pagesRead >= MAX_SOURCE_PAGES) {
			throw new PluginRouteError(
				"LEARN_CONTENT_SCALE_LIMIT",
				`Published Lesson projection scans are limited to ${MAX_SOURCE_PAGES} source pages.`,
				503,
			);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);

	const lessons: PublishedLessonSummary[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (seen.has(row.stepId)) continue;
		seen.add(row.stepId);
		const item = await content.get(LESSONS_COLLECTION_SLUG, row.stepId);
		if (!item || !isPublishedLessonContent(item) || stringField(item.data, "course") !== courseId) {
			continue;
		}
		lessons.push(toLessonSummary(item));
	}
	/* oxlint-enable no-await-in-loop */

	// oxlint-disable-next-line no-array-sort -- sorting a local copy for deterministic lesson order
	return lessons.sort((left, right) => {
		const byOrder = left.order - right.order;
		return byOrder === 0 ? left.id.localeCompare(right.id) : byOrder;
	});
}

export async function getPublishedCourse(
	ctx: PluginContext,
	lookup: PublishedCourseLookup,
): Promise<PublishedCourseDetail | null> {
	const item = await findPublishedCourse(ctx, lookup);
	if (!item) return null;
	return {
		course: toPublishedCourse(item),
		lessons: await publishedLessonSummaries(ctx, item.id),
	};
}

async function findPublishedLessonIndexRow(
	ctx: PluginContext,
	courseId: string,
	lessonId: string,
): Promise<CourseContentIndexRow | null> {
	const index = requireContentIndex(ctx);
	let cursor: string | undefined;
	let pagesRead = 0;
	/* oxlint-disable no-await-in-loop */
	do {
		pagesRead += 1;
		const page = await index.query({
			where: { courseId, stepType: "lesson" },
			limit: 100,
			cursor,
		});
		const match = page.items
			.map((row) => row.data)
			.find(
				(row): row is CourseContentIndexRow =>
					isCourseContentIndexRow(row) && row.stepId === lessonId && row.status === "published",
			);
		if (match) return match;
		if (page.hasMore && !page.cursor) {
			throw new PluginRouteError(
				"LEARN_INDEX_PAGINATION_INVALID",
				"Published Lesson projection pagination could not continue deterministically.",
				503,
			);
		}
		if (page.hasMore && pagesRead >= MAX_SOURCE_PAGES) {
			throw new PluginRouteError(
				"LEARN_CONTENT_SCALE_LIMIT",
				`Published Lesson projection scans are limited to ${MAX_SOURCE_PAGES} source pages.`,
				503,
			);
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
	return null;
}

export async function getPublishedLesson(
	ctx: PluginContext,
	lessonId: string,
): Promise<PublishedLesson | null> {
	const content = requireContent(ctx);
	const lesson = await content.get(LESSONS_COLLECTION_SLUG, lessonId);
	if (!lesson || !isPublishedLessonContent(lesson)) return null;

	const courseId = stringField(lesson.data, "course");
	if (!courseId) return null;
	const course = await content.get(COURSES_COLLECTION_SLUG, courseId);
	if (!course || !isPublishedCourseContent(course)) return null;

	const indexRow = await findPublishedLessonIndexRow(ctx, courseId, lessonId);
	if (!indexRow) return null;
	return toPublishedLesson(lesson, courseId);
}

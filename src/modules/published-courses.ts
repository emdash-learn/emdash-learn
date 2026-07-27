import { PluginRouteError, type PluginContext } from "emdash";

import { COURSES_COLLECTION_SLUG } from "../constants.js";
import {
	isPublishedCourseContent,
	optionalPublishedNumber as numberField,
	optionalPublishedString as stringField,
	publishedSeo as seoField,
	requireContent,
	type PublishedSeo,
	type RuntimeContentItem,
} from "./published-content.js";
import { listPublishedLessonsByCourse, type PublishedLessonSummary } from "./published-lessons.js";

export type { PublishedSeo } from "./published-content.js";
export { resolvePublishedLesson as getPublishedLesson } from "./published-lessons.js";
export type { PublishedLesson, PublishedLessonSummary } from "./published-lessons.js";

const MAX_SOURCE_PAGES = 100;

export type PublishedCourseDifficulty = "beginner" | "intermediate" | "advanced";

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

export interface PublishedCourseDetail {
	course: PublishedCourse;
	lessons: PublishedLessonSummary[];
}

export interface PublishedCourseLookup {
	courseId?: string;
	slug?: string;
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

export async function getPublishedCourse(
	ctx: PluginContext,
	lookup: PublishedCourseLookup,
): Promise<PublishedCourseDetail | null> {
	const item = await findPublishedCourse(ctx, lookup);
	if (!item) return null;
	return {
		course: toPublishedCourse(item),
		lessons: await listPublishedLessonsByCourse(ctx, item.id),
	};
}

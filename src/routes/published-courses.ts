import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute } from "emdash";

import {
	getPublishedCourse,
	getPublishedLesson,
	listPublishedCourses,
	type PublishedCourseCatalogInput,
	type PublishedCourseLookup,
} from "../modules/published-courses.js";

const boundedId = z.string().trim().min(1).max(200);

export const publishedCatalogInput = z
	.object({
		cursor: z.string().max(2048).optional(),
		limit: z.number().int().min(1).max(100).optional(),
		search: z.string().max(200).optional(),
		difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
	})
	.strict();

const catalog: PluginRoute<PublishedCourseCatalogInput> = {
	input: publishedCatalogInput,
	public: true,
	cacheControl: "public, max-age=60, stale-while-revalidate=300",
	handler: (ctx) => listPublishedCourses(ctx, ctx.input),
};

export const publishedCourseGetInput = z
	.object({
		courseId: boundedId.optional(),
		slug: boundedId.optional(),
	})
	.strict()
	.refine((input) => Boolean(input.courseId) !== Boolean(input.slug), {
		message: "Provide exactly one of courseId or slug.",
	});

const courseGet: PluginRoute<PublishedCourseLookup> = {
	input: publishedCourseGetInput,
	public: true,
	cacheControl: "public, max-age=60, stale-while-revalidate=300",
	handler: async (ctx) => {
		const course = await getPublishedCourse(ctx, ctx.input);
		if (course) return course;
		throw new PluginRouteError("LEARN_COURSE_NOT_FOUND", "Published course not found.", 404);
	},
};

export const publishedLessonGetInput = z
	.object({
		lessonId: boundedId,
	})
	.strict();
export type PublishedLessonGetInput = z.infer<typeof publishedLessonGetInput>;

const lessonGet: PluginRoute<PublishedLessonGetInput> = {
	input: publishedLessonGetInput,
	public: true,
	cacheControl: "public, max-age=60, stale-while-revalidate=300",
	handler: async (ctx) => {
		const lesson = await getPublishedLesson(ctx, ctx.input.lessonId);
		if (lesson) return { lesson };
		throw new PluginRouteError("LEARN_LESSON_NOT_FOUND", "Published lesson not found.", 404);
	},
};

export const publishedCourseRoutes = {
	catalog,
	"course:get": courseGet,
	"lesson:get": lessonGet,
} as const;

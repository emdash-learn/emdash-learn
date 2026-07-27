import { describe, expect, it, vi } from "vitest";
import type { ContentItem, PluginContext } from "emdash";

import {
	listPublishedLessonsByCourse,
	resolvePublishedLesson,
	synchronizePublishedLesson,
} from "../../../src/modules/published-lessons.js";
import { createMemoryStorageCollection } from "../../utils/memory-storage.js";

function contentItem(
	collection: "courses" | "lessons",
	id: string,
	data: Record<string, unknown>,
	overrides: Partial<ContentItem> = {},
): ContentItem {
	return {
		id,
		type: collection,
		slug: id,
		status: "published",
		locale: "en",
		data,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		publishedAt: "2026-01-03T00:00:00.000Z",
		...overrides,
	};
}

function createContext(items: ContentItem[]) {
	const contentItems = new Map(items.map((item) => [`${item.type}/${item.id}`, item]));
	const get = vi.fn(async (collection: string, id: string) => {
		return contentItems.get(`${collection}/${id}`) ?? null;
	});
	const list = vi.fn(async () => ({ items: [], hasMore: false as const }));
	const index = createMemoryStorageCollection<unknown>();
	const indexRows = index.documents;
	const warn = vi.fn();

	// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- complete in-memory EmDash context fake
	const ctx = {
		storage: { course_content_index: index },
		content: {
			get,
			list,
		},
		log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
	} as unknown as PluginContext;

	return { ctx, contentItems, get, list, index, indexRows, warn };
}

describe("Published Lessons", () => {
	it("rereads authoritative content and moves a canonical Lesson to its current Course", async () => {
		const lesson = contentItem("lessons", "lesson-1", {
			title: "Authoritative title",
			course: "course-new",
			order: 7,
		});
		const fixture = createContext([lesson]);
		fixture.indexRows.set("idx__course-old__lesson__lesson-1", {
			courseId: "course-old",
			stepType: "lesson",
			stepId: "lesson-1",
			order: 2,
			status: "published",
		});

		await expect(synchronizePublishedLesson(fixture.ctx, lesson.id)).resolves.toEqual({
			status: "indexed",
			lessonId: "lesson-1",
			courseId: "course-new",
			removedPointers: 1,
		});
		expect(fixture.get).toHaveBeenCalledWith("lessons", "lesson-1");
		expect([...fixture.indexRows.entries()]).toEqual([
			[
				"idx__course-new__lesson__lesson-1",
				{
					courseId: "course-new",
					stepType: "lesson",
					stepId: "lesson-1",
					order: 7,
					status: "published",
				},
			],
		]);
	});

	it("omits malformed published Lessons with diagnostics instead of manufacturing defaults", async () => {
		const lesson = contentItem("lessons", "lesson-malformed", {
			title: "   ",
			course: " ",
			order: -1,
		});
		const fixture = createContext([lesson]);
		fixture.indexRows.set("idx__course-safe__lesson__lesson-malformed", {
			courseId: "course-safe",
			stepType: "lesson",
			stepId: "lesson-malformed",
			order: 0,
			status: "published",
		});

		await expect(synchronizePublishedLesson(fixture.ctx, lesson.id)).resolves.toEqual({
			status: "omitted",
			lessonId: "lesson-malformed",
			removedPointers: 1,
			diagnostics: [
				{
					code: "LESSON_COURSE_ID_INVALID",
					field: "course",
					message: "Published Lesson Course reference must not be blank.",
				},
				{
					code: "LESSON_TITLE_BLANK",
					field: "title",
					message: "Published Lesson title must not be blank.",
				},
				{
					code: "LESSON_ORDER_INVALID",
					field: "order",
					message: "Published Lesson order must be a nonnegative integer.",
				},
			],
		});
		expect(fixture.indexRows.size).toBe(0);
		expect(fixture.warn).toHaveBeenCalledWith("Malformed Published Lesson omitted.", {
			lessonId: "lesson-malformed",
			diagnostics: [
				expect.objectContaining({ code: "LESSON_COURSE_ID_INVALID" }),
				expect.objectContaining({ code: "LESSON_TITLE_BLANK" }),
				expect.objectContaining({ code: "LESSON_ORDER_INVALID" }),
			],
		});
	});

	it("omits an authoritative reread whose Lesson ID does not match the requested ID", async () => {
		const returnedLesson = contentItem("lessons", "lesson-other", {
			title: "Other lesson",
			course: "course-safe",
			order: 1,
		});
		const fixture = createContext([]);
		fixture.contentItems.set("lessons/lesson-requested", returnedLesson);

		await expect(synchronizePublishedLesson(fixture.ctx, "lesson-requested")).resolves.toEqual({
			status: "omitted",
			lessonId: "lesson-requested",
			removedPointers: 0,
			diagnostics: [
				{
					code: "LESSON_ID_MISMATCH",
					field: "id",
					message: "Published Lesson ID does not match the requested Lesson.",
				},
			],
		});
		expect(fixture.indexRows.size).toBe(0);
	});

	it("returns a stable removed outcome when the authoritative Lesson no longer exists", async () => {
		const fixture = createContext([]);
		fixture.indexRows.set("idx__course-old__lesson__lesson-deleted", {
			courseId: "course-old",
			stepType: "lesson",
			stepId: "lesson-deleted",
			order: 2,
			status: "published",
		});

		await expect(synchronizePublishedLesson(fixture.ctx, "lesson-deleted")).resolves.toEqual({
			status: "removed",
			lessonId: "lesson-deleted",
			removedPointers: 1,
		});
		expect(fixture.indexRows.size).toBe(0);
	});

	it("does not write a replacement when removal of the prior pointer cannot complete", async () => {
		const lesson = contentItem("lessons", "lesson-1", {
			title: "Canonical lesson",
			course: "course-new",
			order: 7,
		});
		const fixture = createContext([lesson]);
		fixture.indexRows.set("idx__course-old__lesson__lesson-1", {
			courseId: "course-old",
			stepType: "lesson",
			stepId: "lesson-1",
			order: 2,
			status: "published",
		});
		fixture.index.query = vi.fn(async () => ({
			items: [
				{
					id: "idx__course-old__lesson__lesson-1",
					data: fixture.indexRows.get("idx__course-old__lesson__lesson-1"),
				},
			],
			hasMore: true,
		}));
		const put = vi.spyOn(fixture.index, "put");

		await expect(synchronizePublishedLesson(fixture.ctx, lesson.id)).rejects.toMatchObject({
			code: "LEARN_INDEX_PAGINATION_INVALID",
			status: 503,
		});
		expect(put).not.toHaveBeenCalled();
		expect(fixture.indexRows.has("idx__course-new__lesson__lesson-1")).toBe(false);
	});

	it("surfaces a failed pointer deletion and does not write the replacement", async () => {
		const lesson = contentItem("lessons", "lesson-1", {
			title: "Canonical lesson",
			course: "course-new",
			order: 7,
		});
		const fixture = createContext([lesson]);
		const oldPointerId = "idx__course-old__lesson__lesson-1";
		fixture.indexRows.set(oldPointerId, {
			courseId: "course-old",
			stepType: "lesson",
			stepId: "lesson-1",
			order: 2,
			status: "published",
		});
		vi.spyOn(fixture.index, "delete").mockResolvedValue(false);
		const put = vi.spyOn(fixture.index, "put");

		await expect(synchronizePublishedLesson(fixture.ctx, lesson.id)).rejects.toMatchObject({
			code: "LEARN_INDEX_REMOVE_FAILED",
			status: 503,
		});
		expect(put).not.toHaveBeenCalled();
		expect(fixture.indexRows.has(oldPointerId)).toBe(true);
		expect(fixture.indexRows.has("idx__course-new__lesson__lesson-1")).toBe(false);
	});

	it("lists only canonical projected Lessons under a canonical published Course without scanning content", async () => {
		const course = contentItem("courses", "course-safe", { title: "Safe course" });
		const lesson = contentItem(
			"lessons",
			"lesson-visible",
			{
				title: "Visible lesson",
				course: course.id,
				order: 4,
				summary: "Public summary",
			},
			{ slug: "visible-lesson" },
		);
		const malformed = contentItem("lessons", "lesson-malformed", {
			title: " ",
			course: course.id,
			order: 2,
		});
		const moved = contentItem("lessons", "lesson-moved", {
			title: "Moved lesson",
			course: "course-other",
			order: 1,
		});
		const fixture = createContext([course, lesson, malformed, moved]);
		fixture.indexRows.set("visible", {
			courseId: course.id,
			stepType: "lesson",
			stepId: lesson.id,
			order: 99,
			status: "published",
		});
		fixture.indexRows.set("malformed", {
			courseId: course.id,
			stepType: "lesson",
			stepId: malformed.id,
			order: 2,
			status: "published",
		});
		fixture.indexRows.set("moved", {
			courseId: course.id,
			stepType: "lesson",
			stepId: moved.id,
			order: 1,
			status: "published",
		});
		fixture.indexRows.set("invalid-row", {
			courseId: course.id,
			stepType: "lesson",
			stepId: "lesson-invalid-row",
			order: -1,
			status: "published",
		});

		await expect(listPublishedLessonsByCourse(fixture.ctx, course.id)).resolves.toEqual([
			{
				id: "lesson-visible",
				slug: "visible-lesson",
				title: "Visible lesson",
				order: 4,
				summary: "Public summary",
				publishedAt: "2026-01-03T00:00:00.000Z",
			},
		]);
		expect(fixture.list).not.toHaveBeenCalled();
		expect(fixture.warn).toHaveBeenCalledWith("Malformed Published Lesson omitted.", {
			lessonId: "lesson-malformed",
			diagnostics: [expect.objectContaining({ code: "LESSON_TITLE_BLANK" })],
		});

		fixture.contentItems.set(
			`courses/${course.id}`,
			contentItem("courses", course.id, { title: "Safe course" }, { status: "draft" }),
		);
		await expect(listPublishedLessonsByCourse(fixture.ctx, course.id)).resolves.toEqual([]);
	});

	it("directly resolves only a canonical projected Lesson whose parent Course remains published", async () => {
		const course = contentItem("courses", "course-safe", { title: "Safe course" });
		const lesson = contentItem(
			"lessons",
			"lesson-safe",
			{
				title: "Safe lesson",
				course: course.id,
				order: 3,
				body: [{ _type: "paragraph", text: "Lesson body" }],
			},
			{
				slug: "safe-lesson",
				seo: {
					title: "Lesson SEO",
					description: null,
					image: null,
					canonical: null,
					noIndex: true,
				},
			},
		);
		const fixture = createContext([course, lesson]);
		fixture.indexRows.set("pointer", {
			courseId: course.id,
			stepType: "lesson",
			stepId: lesson.id,
			order: 3,
			status: "published",
		});

		await expect(resolvePublishedLesson(fixture.ctx, lesson.id)).resolves.toEqual({
			id: "lesson-safe",
			slug: "safe-lesson",
			title: "Safe lesson",
			order: 3,
			publishedAt: "2026-01-03T00:00:00.000Z",
			courseId: "course-safe",
			body: [{ _type: "paragraph", text: "Lesson body" }],
			locale: "en",
			seo: {
				title: "Lesson SEO",
				description: null,
				image: null,
				canonical: null,
				noIndex: true,
			},
			updatedAt: "2026-01-02T00:00:00.000Z",
		});
		expect(fixture.list).not.toHaveBeenCalled();

		fixture.contentItems.set(
			`courses/${course.id}`,
			contentItem("courses", course.id, { title: "Safe course" }, { status: "draft" }),
		);
		await expect(resolvePublishedLesson(fixture.ctx, lesson.id)).resolves.toBeNull();
	});
});

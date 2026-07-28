import { describe, expect, it, vi } from "vitest";
import type {
	ContentItem,
	ContentListOptions,
	PluginContext,
	QueryOptions,
	StorageCollection,
} from "emdash";

import {
	listPublishedLessonsByCourse,
	repairPublishedLessons,
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

type IndexRow = Record<string, unknown>;

function lessonRow(courseId: string, stepId: string, order: number): IndexRow {
	return { courseId, stepType: "lesson", stepId, order, status: "published" };
}

/**
 * Repair scans authoritative content and the whole projection, so its fixture
 * paginates both and enforces the declared unique `stepId` index.
 */
function createRepairFixture(pageSize = 1) {
	const collections = new Map<string, Map<string, ContentItem>>([
		["courses", new Map()],
		["lessons", new Map()],
	]);
	const stored = createMemoryStorageCollection<IndexRow>();
	const indexRows = stored.documents;
	const warn = vi.fn();
	const info = vi.fn();

	// The declared `stepId` unique index and small storage pages are what make
	// repair remove a moved pointer before writing its replacement, so the
	// shared in-memory collection is wrapped rather than replaced.
	const index: StorageCollection<IndexRow> = {
		...stored,
		async put(id, data) {
			const conflicting = [...indexRows.entries()].find(
				([existingId, existing]) =>
					existingId !== id &&
					typeof data["stepId"] === "string" &&
					existing["stepId"] === data["stepId"],
			);
			if (conflicting) throw new Error(`Unique stepId conflict with ${conflicting[0]}.`);
			return stored.put(id, data);
		},
		async query(options: QueryOptions = {}) {
			return stored.query({ ...options, limit: Math.min(options.limit ?? pageSize, pageSize) });
		},
	};

	// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- complete in-memory EmDash context fake
	const ctx = {
		storage: { course_content_index: index },
		content: {
			async get(collection: string, id: string) {
				return collections.get(collection)?.get(id) ?? null;
			},
			async list(collection: string, options: ContentListOptions = {}) {
				const matching = [...(collections.get(collection)?.values() ?? [])].filter(
					(item) => options.where?.status === undefined || item.status === options.where.status,
				);
				// oxlint-disable-next-line no-array-sort -- sorting a local fixture copy
				matching.sort((left, right) => left.id.localeCompare(right.id));
				const offset = options.cursor ? Number(options.cursor) : 0;
				const limit = Math.min(options.limit ?? matching.length, pageSize);
				const items = matching.slice(offset, offset + limit);
				const nextOffset = offset + items.length;
				const hasMore = nextOffset < matching.length;
				return { items, hasMore, ...(hasMore ? { cursor: String(nextOffset) } : {}) };
			},
		},
		log: { debug: vi.fn(), info, warn, error: vi.fn() },
	} as unknown as PluginContext;

	return {
		ctx,
		index,
		indexRows,
		warn,
		info,
		add(item: ContentItem) {
			collections.get(item.type)?.set(item.id, item);
			return item;
		},
	};
}

describe("Published Lessons repair", () => {
	it("reconciles missing, moved, stale, and legacy rows from a complete multi-page scan", async () => {
		const fixture = createRepairFixture(1);
		for (const id of ["course-old", "course-new", "course-other"]) {
			fixture.add(contentItem("courses", id, { title: id }));
		}
		fixture.add(
			contentItem("lessons", "lesson-moved", {
				title: "Moved lesson",
				course: "course-new",
				order: 2,
			}),
		);
		fixture.add(
			contentItem("lessons", "lesson-other", {
				title: "Other lesson",
				course: "course-other",
				order: 1,
			}),
		);
		fixture.add(
			contentItem(
				"lessons",
				"lesson-draft",
				{ title: "Draft lesson", course: "course-old", order: 3 },
				{ status: "draft", publishedAt: null },
			),
		);
		fixture.indexRows.set("01-old-assignment", lessonRow("course-old", "lesson-moved", 2));
		fixture.indexRows.set("02-deleted", lessonRow("course-old", "lesson-deleted", 4));
		fixture.indexRows.set("03-draft", lessonRow("course-old", "lesson-draft", 3));
		fixture.indexRows.set("04-legacy", {
			courseId: "course-old",
			stepType: "topic",
			stepId: "topic-legacy",
			order: 5,
			status: "published",
		});

		await expect(repairPublishedLessons(fixture.ctx)).resolves.toEqual({
			complete: true,
			lessonsUpserted: 2,
			staleRowsDeleted: 4,
			errors: 0,
			diagnostics: [],
		});
		await expect(listPublishedLessonsByCourse(fixture.ctx, "course-old")).resolves.toEqual([]);
		await expect(listPublishedLessonsByCourse(fixture.ctx, "course-new")).resolves.toEqual([
			{
				id: "lesson-moved",
				slug: "lesson-moved",
				title: "Moved lesson",
				order: 2,
				publishedAt: "2026-01-03T00:00:00.000Z",
			},
		]);
	});

	it("converges on the same projection when a successful repair is repeated", async () => {
		const fixture = createRepairFixture(2);
		fixture.add(contentItem("courses", "course-safe", { title: "Safe course" }));
		fixture.add(
			contentItem("lessons", "lesson-a", { title: "Lesson A", course: "course-safe", order: 1 }),
		);
		fixture.add(
			contentItem("lessons", "lesson-b", { title: "Lesson B", course: "course-safe", order: 2 }),
		);
		fixture.indexRows.set("stale", lessonRow("course-gone", "lesson-gone", 1));

		const first = await repairPublishedLessons(fixture.ctx);
		const afterFirst = new Map(fixture.indexRows);
		const second = await repairPublishedLessons(fixture.ctx);

		expect({ first, second }).toEqual({
			first: {
				complete: true,
				lessonsUpserted: 2,
				staleRowsDeleted: 1,
				errors: 0,
				diagnostics: [],
			},
			second: {
				complete: true,
				lessonsUpserted: 2,
				staleRowsDeleted: 0,
				errors: 0,
				diagnostics: [],
			},
		});
		expect([...fixture.indexRows.entries()]).toEqual([...afterFirst.entries()]);
	});

	it("reports malformed published Lessons instead of manufacturing projection defaults", async () => {
		const fixture = createRepairFixture(2);
		fixture.add(contentItem("courses", "course-safe", { title: "Safe course" }));
		fixture.add(
			contentItem("lessons", "lesson-valid", {
				title: "Valid lesson",
				course: "course-safe",
				order: 1,
			}),
		);
		fixture.add(
			contentItem("lessons", "lesson-blank-title", {
				title: "  ",
				course: "course-safe",
				order: 2,
			}),
		);
		fixture.add(contentItem("lessons", "lesson-orphan", { title: "Missing Course", order: 3 }));
		fixture.indexRows.set("blank-title", lessonRow("course-safe", "lesson-blank-title", 2));

		const report = await repairPublishedLessons(fixture.ctx);

		expect(report).toEqual({
			complete: false,
			lessonsUpserted: 1,
			staleRowsDeleted: 1,
			errors: 2,
			diagnostics: [
				{
					code: "LESSON_TITLE_BLANK",
					lessonId: "lesson-blank-title",
					message: "Published Lesson title must not be blank.",
				},
				{
					code: "LESSON_COURSE_ID_INVALID",
					lessonId: "lesson-orphan",
					message: "Published Lesson Course reference must not be blank.",
				},
			],
		});
		await expect(listPublishedLessonsByCourse(fixture.ctx, "course-safe")).resolves.toEqual([
			{
				id: "lesson-valid",
				slug: "lesson-valid",
				title: "Valid lesson",
				order: 1,
				publishedAt: "2026-01-03T00:00:00.000Z",
			},
		]);
	});

	it("leaves the existing projection untouched when authoritative pagination is incomplete", async () => {
		const fixture = createRepairFixture();
		fixture.add(contentItem("courses", "course-safe", { title: "Safe course" }));
		fixture.add(
			contentItem("lessons", "lesson-existing", {
				title: "Existing lesson",
				course: "course-safe",
				order: 1,
			}),
		);
		fixture.indexRows.set("existing-pointer", lessonRow("course-safe", "lesson-existing", 1));
		const get = fixture.ctx.content!.get.bind(fixture.ctx.content);
		fixture.ctx.content = {
			get,
			async list() {
				return {
					items: [
						contentItem("lessons", "lesson-partial", {
							title: "Partial page lesson",
							course: "course-safe",
							order: 2,
						}),
					],
					hasMore: true,
				};
			},
		};

		await expect(repairPublishedLessons(fixture.ctx)).resolves.toEqual({
			complete: false,
			lessonsUpserted: 0,
			staleRowsDeleted: 0,
			errors: 1,
			diagnostics: [
				{
					code: "LESSON_SCAN_INCOMPLETE",
					message: "Published Lesson pagination could not continue deterministically.",
				},
			],
		});
		expect([...fixture.indexRows.keys()]).toEqual(["existing-pointer"]);
	});

	it("stops the authoritative scan at the explicit page limit before writing", async () => {
		const fixture = createRepairFixture();
		fixture.indexRows.set("existing-pointer", lessonRow("course-large", "lesson-existing", 1));
		let pagesRead = 0;
		fixture.ctx.content = {
			async get() {
				return null;
			},
			async list() {
				pagesRead += 1;
				return {
					items: [
						contentItem("lessons", `lesson-${pagesRead}`, {
							title: `Lesson ${pagesRead}`,
							course: "course-large",
							order: pagesRead,
						}),
					],
					hasMore: true,
					cursor: `page-${pagesRead + 1}`,
				};
			},
		};

		const report = await repairPublishedLessons(fixture.ctx);

		expect({ report, pagesRead }).toEqual({
			report: {
				complete: false,
				lessonsUpserted: 0,
				staleRowsDeleted: 0,
				errors: 1,
				diagnostics: [
					{
						code: "LESSON_SCAN_INCOMPLETE",
						message: "Published Lesson scans are limited to 100 pages.",
					},
				],
			},
			pagesRead: 100,
		});
		expect([...fixture.indexRows.keys()]).toEqual(["existing-pointer"]);
	});

	it("does not reconcile against an incomplete scan of the existing projection", async () => {
		const fixture = createRepairFixture();
		fixture.add(contentItem("courses", "course-safe", { title: "Safe course" }));
		fixture.add(
			contentItem("lessons", "lesson-a", { title: "Lesson A", course: "course-safe", order: 1 }),
		);
		fixture.indexRows.set("pointer-a", lessonRow("course-safe", "lesson-a", 1));
		fixture.indexRows.set("pointer-stale", lessonRow("course-safe", "lesson-stale", 2));
		fixture.index.query = async () => ({
			items: [{ id: "pointer-a", data: fixture.indexRows.get("pointer-a")! }],
			hasMore: true,
		});

		await expect(repairPublishedLessons(fixture.ctx)).resolves.toEqual({
			complete: false,
			lessonsUpserted: 0,
			staleRowsDeleted: 0,
			errors: 1,
			diagnostics: [
				{
					code: "PROJECTION_SCAN_INCOMPLETE",
					message: "Published Lesson projection pagination could not continue deterministically.",
				},
			],
		});
		expect([...fixture.indexRows.keys()]).toEqual(["pointer-a", "pointer-stale"]);
	});

	it("reports a failed authoritative read as an unreconciled scan failure", async () => {
		const fixture = createRepairFixture();
		fixture.indexRows.set("existing-pointer", lessonRow("course-safe", "lesson-existing", 1));
		fixture.ctx.content = {
			async get() {
				return null;
			},
			async list() {
				throw new Error("Content service unavailable.");
			},
		};

		await expect(repairPublishedLessons(fixture.ctx)).resolves.toEqual({
			complete: false,
			lessonsUpserted: 0,
			staleRowsDeleted: 0,
			errors: 1,
			diagnostics: [
				{
					code: "LESSON_SCAN_FAILED",
					message: "Published Lessons could not be read: Content service unavailable.",
				},
			],
		});
		expect([...fixture.indexRows.keys()]).toEqual(["existing-pointer"]);
	});

	it("reports projection write failures without claiming a complete repair", async () => {
		const fixture = createRepairFixture(2);
		fixture.add(contentItem("courses", "course-safe", { title: "Safe course" }));
		fixture.add(
			contentItem("lessons", "lesson-a", { title: "Lesson A", course: "course-safe", order: 1 }),
		);
		fixture.add(
			contentItem("lessons", "lesson-b", { title: "Lesson B", course: "course-safe", order: 2 }),
		);
		fixture.indexRows.set("stale", lessonRow("course-gone", "lesson-gone", 1));
		const put = fixture.index.put.bind(fixture.index);
		fixture.index.put = async (id, data) => {
			if (id.endsWith("lesson-a")) throw new Error("Storage rejected the write.");
			return put(id, data);
		};
		fixture.index.delete = async () => {
			throw new Error("Storage rejected the removal.");
		};

		const report = await repairPublishedLessons(fixture.ctx);

		expect(report).toEqual({
			complete: false,
			lessonsUpserted: 1,
			staleRowsDeleted: 0,
			errors: 2,
			diagnostics: [
				{
					code: "PROJECTION_UPSERT_FAILED",
					lessonId: "lesson-a",
					rowId: "idx__course-safe__lesson__lesson-a",
					message: "Storage rejected the write.",
				},
				{
					code: "PROJECTION_REMOVE_FAILED",
					rowId: "stale",
					message: "Storage rejected the removal.",
				},
			],
		});
		expect(fixture.indexRows.has("stale")).toBe(true);
	});

	it("does not replace a moved Lesson pointer that could not be removed", async () => {
		const fixture = createRepairFixture(2);
		fixture.add(contentItem("courses", "course-new", { title: "New course" }));
		fixture.add(
			contentItem("lessons", "lesson-moved", {
				title: "Moved lesson",
				course: "course-new",
				order: 1,
			}),
		);
		fixture.indexRows.set("old-pointer", lessonRow("course-old", "lesson-moved", 1));
		fixture.index.delete = async () => {
			throw new Error("Storage rejected the removal.");
		};

		await expect(repairPublishedLessons(fixture.ctx)).resolves.toEqual({
			complete: false,
			lessonsUpserted: 0,
			staleRowsDeleted: 0,
			errors: 1,
			diagnostics: [
				{
					code: "PROJECTION_REMOVE_FAILED",
					lessonId: "lesson-moved",
					rowId: "old-pointer",
					message: "Storage rejected the removal.",
				},
			],
		});
		expect([...fixture.indexRows.keys()]).toEqual(["old-pointer"]);
	});

	it("reports unavailable content and projection access without partial writes", async () => {
		const fixture = createRepairFixture();
		fixture.ctx.content = undefined;
		fixture.ctx.storage = {};

		await expect(repairPublishedLessons(fixture.ctx)).resolves.toEqual({
			complete: false,
			lessonsUpserted: 0,
			staleRowsDeleted: 0,
			errors: 2,
			diagnostics: [
				{
					code: "CONTENT_UNAVAILABLE",
					message: "Authoritative content access is unavailable.",
				},
				{
					code: "PROJECTION_UNAVAILABLE",
					message: "Published Lesson projection storage is unavailable.",
				},
			],
		});
	});
});

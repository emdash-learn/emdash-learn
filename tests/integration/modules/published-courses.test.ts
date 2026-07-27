import { describe, expect, it } from "vitest";
import type {
	ContentItem,
	ContentListOptions,
	PluginContext,
	QueryOptions,
	StorageCollection,
} from "emdash";

import {
	getPublishedCourse,
	getPublishedLesson,
	listPublishedCourses,
} from "../../../src/modules/published-courses.js";

type IndexRow = Record<string, unknown>;

function storageCollection(
	rows: Map<string, IndexRow>,
	backendPageSize = Number.POSITIVE_INFINITY,
): StorageCollection<IndexRow> {
	return {
		async get(id) {
			return rows.get(id) ?? null;
		},
		async put(id, data) {
			rows.set(id, structuredClone(data));
		},
		async delete(id) {
			return rows.delete(id);
		},
		async exists(id) {
			return rows.has(id);
		},
		async getMany(ids) {
			return new Map(ids.flatMap((id) => (rows.has(id) ? [[id, rows.get(id)!]] : [])));
		},
		async putMany(items) {
			for (const item of items) rows.set(item.id, structuredClone(item.data));
		},
		async deleteMany(ids) {
			let deleted = 0;
			for (const id of ids) {
				if (rows.delete(id)) deleted += 1;
			}
			return deleted;
		},
		async query(options: QueryOptions = {}) {
			const matching = [...rows.entries()].filter(([, row]) =>
				Object.entries(options.where ?? {}).every(([field, expected]) => row[field] === expected),
			);
			// oxlint-disable-next-line no-array-sort -- sorting a local fixture copy
			matching.sort(([left], [right]) => left.localeCompare(right));
			const offset = options.cursor ? Number(options.cursor) : 0;
			const limit = Math.min(options.limit ?? matching.length, backendPageSize);
			const items = matching.slice(offset, offset + limit).map(([id, data]) => ({ id, data }));
			const nextOffset = offset + items.length;
			const hasMore = nextOffset < matching.length;
			return {
				items,
				hasMore,
				...(hasMore ? { cursor: String(nextOffset) } : {}),
			};
		},
		async count(where) {
			return (await this.query({ where })).items.length;
		},
	};
}

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

function createContext(options: { contentPageSize?: number; indexPageSize?: number } = {}) {
	const collections = new Map<string, Map<string, ContentItem>>([
		["courses", new Map()],
		["lessons", new Map()],
	]);
	const indexRows = new Map<string, IndexRow>();

	// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- complete in-memory EmDash context fake
	const ctx = {
		storage: {
			course_content_index: storageCollection(
				indexRows,
				options.indexPageSize ?? Number.POSITIVE_INFINITY,
			),
		},
		content: {
			async get(collection: string, id: string) {
				return collections.get(collection)?.get(id) ?? null;
			},
			async list(collection: string, listOptions: ContentListOptions = {}) {
				const matching = [...(collections.get(collection)?.values() ?? [])].filter(
					(item) =>
						listOptions.where?.status === undefined || item.status === listOptions.where.status,
				);
				// oxlint-disable-next-line no-array-sort -- sorting a local fixture copy
				matching.sort((left, right) => left.id.localeCompare(right.id));
				const offset = listOptions.cursor ? Number(listOptions.cursor) : 0;
				const limit = Math.min(
					listOptions.limit ?? matching.length,
					options.contentPageSize ?? Number.POSITIVE_INFINITY,
				);
				const items = matching.slice(offset, offset + limit);
				const nextOffset = offset + items.length;
				const hasMore = nextOffset < matching.length;
				return {
					items,
					hasMore,
					...(hasMore ? { cursor: String(nextOffset) } : {}),
				};
			},
		},
		log: { debug() {}, info() {}, warn() {}, error() {} },
	} as unknown as PluginContext;

	return {
		ctx,
		indexRows,
		add(item: ContentItem) {
			collections.get(item.type)?.set(item.id, item);
			return item;
		},
	};
}

describe("Course Publishing", () => {
	it("returns explicitly allowlisted Course, Lesson, image, and SEO DTOs", async () => {
		const fixture = createContext();
		const courseSeo: NonNullable<ContentItem["seo"]> = {
			title: "SEO title",
			description: "SEO description",
			image: "/seo.webp",
			canonical: "https://example.test/courses/safe-publishing",
			noIndex: false,
		};
		Reflect.set(courseSeo, "internal", "must not cross the seam");
		const lessonSeo: NonNullable<ContentItem["seo"]> = {
			title: "Lesson SEO",
			description: null,
			image: null,
			canonical: null,
			noIndex: true,
		};
		Reflect.set(lessonSeo, "internal", "must not cross the seam");
		const course = fixture.add(
			contentItem(
				"courses",
				"course-safe",
				{
					title: "Safe publishing",
					subtitle: "Public subtitle",
					description: "Public description",
					body: [{ _type: "paragraph", text: "Course body" }],
					cover_image: {
						id: "cover-1",
						provider: "local",
						src: "/cover.webp",
						previewUrl: "/cover-preview.webp",
						alt: "Course cover",
						width: 1200,
						height: 630,
						filename: "private-internal-name.webp",
					},
					difficulty: "beginner",
					estimated_hours: 3,
					internal_notes: "must not cross the seam",
				},
				{
					slug: "safe-publishing",
					seo: courseSeo,
				},
			),
		);
		const lesson = fixture.add(
			contentItem(
				"lessons",
				"lesson-safe",
				{
					title: "Published safely",
					course: course.id,
					order: 4,
					summary: "Public summary",
					body: [{ _type: "paragraph", text: "Lesson body" }],
					video_url: "https://video.example/lesson",
					duration_seconds: 420,
					answer_key: "must not cross the seam",
				},
				{
					slug: "published-safely",
					seo: lessonSeo,
				},
			),
		);
		fixture.indexRows.set("pointer", {
			courseId: course.id,
			stepType: "lesson",
			stepId: lesson.id,
			order: 99,
			status: "published",
		});

		const detail = await getPublishedCourse(fixture.ctx, { courseId: course.id });
		const fullLesson = await getPublishedLesson(fixture.ctx, lesson.id);

		expect({ detail, fullLesson }).toEqual({
			detail: {
				course: {
					id: "course-safe",
					slug: "safe-publishing",
					title: "Safe publishing",
					subtitle: "Public subtitle",
					description: "Public description",
					body: [{ _type: "paragraph", text: "Course body" }],
					coverImage: {
						id: "cover-1",
						provider: "local",
						src: "/cover.webp",
						previewUrl: "/cover-preview.webp",
						alt: "Course cover",
						width: 1200,
						height: 630,
					},
					difficulty: "beginner",
					estimatedHours: 3,
					publishedAt: "2026-01-03T00:00:00.000Z",
					locale: "en",
					seo: {
						title: "SEO title",
						description: "SEO description",
						image: "/seo.webp",
						canonical: "https://example.test/courses/safe-publishing",
						noIndex: false,
					},
					updatedAt: "2026-01-02T00:00:00.000Z",
				},
				lessons: [
					{
						id: "lesson-safe",
						slug: "published-safely",
						title: "Published safely",
						order: 4,
						summary: "Public summary",
						videoUrl: "https://video.example/lesson",
						durationSeconds: 420,
						publishedAt: "2026-01-03T00:00:00.000Z",
					},
				],
			},
			fullLesson: {
				id: "lesson-safe",
				slug: "published-safely",
				title: "Published safely",
				order: 4,
				summary: "Public summary",
				videoUrl: "https://video.example/lesson",
				durationSeconds: 420,
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
			},
		});
	});

	it("rejects malformed content and stale, reassigned, draft, scheduled, or topic pointers", async () => {
		const fixture = createContext();
		const course = fixture.add(contentItem("courses", "course-public", { title: "Public course" }));
		fixture.add(contentItem("courses", "course-other", { title: "Other course" }));
		const malformedCourse = fixture.add(contentItem("courses", "course-malformed", { title: 42 }));
		const validLesson = fixture.add(
			contentItem("lessons", "lesson-valid", {
				title: "Visible lesson",
				course: course.id,
				order: 1,
			}),
		);
		const topicOnlyLesson = fixture.add(
			contentItem("lessons", "lesson-topic-pointer", {
				title: "Legacy topic pointer",
				course: course.id,
				order: 2,
			}),
		);
		const draftLesson = fixture.add(
			contentItem(
				"lessons",
				"lesson-draft",
				{ title: "Draft lesson", course: course.id, order: 3 },
				{ status: "draft", publishedAt: null },
			),
		);
		const scheduledLesson = fixture.add(
			contentItem(
				"lessons",
				"lesson-scheduled",
				{ title: "Scheduled lesson", course: course.id, order: 4 },
				{ status: "scheduled", publishedAt: null },
			),
		);
		const reassignedLesson = fixture.add(
			contentItem("lessons", "lesson-reassigned", {
				title: "Moved lesson",
				course: "course-other",
				order: 5,
			}),
		);
		const malformedLesson = fixture.add(
			contentItem("lessons", "lesson-malformed", {
				title: "",
				course: course.id,
				order: "six",
			}),
		);

		fixture.indexRows.set("01-valid", {
			courseId: course.id,
			stepType: "lesson",
			stepId: validLesson.id,
			order: 1,
			status: "published",
		});
		fixture.indexRows.set("02-topic", {
			courseId: course.id,
			stepType: "topic",
			stepId: topicOnlyLesson.id,
			order: 2,
			status: "published",
		});
		fixture.indexRows.set("03-draft", {
			courseId: course.id,
			stepType: "lesson",
			stepId: draftLesson.id,
			order: 3,
			status: "published",
		});
		fixture.indexRows.set("04-scheduled", {
			courseId: course.id,
			stepType: "lesson",
			stepId: scheduledLesson.id,
			order: 4,
			status: "published",
		});
		fixture.indexRows.set("05-reassigned", {
			courseId: course.id,
			stepType: "lesson",
			stepId: reassignedLesson.id,
			order: 5,
			status: "published",
		});
		fixture.indexRows.set("06-deleted", {
			courseId: course.id,
			stepType: "lesson",
			stepId: "lesson-deleted",
			order: 6,
			status: "published",
		});
		fixture.indexRows.set("07-malformed", {
			courseId: course.id,
			stepType: "lesson",
			stepId: malformedLesson.id,
			order: 7,
			status: "published",
		});

		const detail = await getPublishedCourse(fixture.ctx, { courseId: course.id });

		expect({
			detail,
			malformedCourse: await getPublishedCourse(fixture.ctx, {
				courseId: malformedCourse.id,
			}),
			malformedLesson: await getPublishedLesson(fixture.ctx, malformedLesson.id),
		}).toEqual({
			detail: {
				course: expect.objectContaining({ id: course.id, title: "Public course" }),
				lessons: [
					{
						id: "lesson-valid",
						slug: "lesson-valid",
						title: "Visible lesson",
						order: 1,
						publishedAt: "2026-01-03T00:00:00.000Z",
					},
				],
			},
			malformedCourse: null,
			malformedLesson: null,
		});
	});

	it("fails closed when authoritative content pagination cannot continue deterministically", async () => {
		const fixture = createContext();
		const onlyReturnedCourse = contentItem("courses", "course-first", {
			title: "First course",
		});
		fixture.ctx.content = {
			async get() {
				return null;
			},
			async list() {
				return {
					items: [onlyReturnedCourse],
					hasMore: true,
				};
			},
		};

		await expect(listPublishedCourses(fixture.ctx, {})).rejects.toMatchObject({
			code: "LEARN_CONTENT_PAGINATION_INVALID",
			status: 503,
		});
	});

	it("stops catalog scans at the explicit source-page scale limit", async () => {
		const fixture = createContext();
		let pagesRead = 0;
		fixture.ctx.content = {
			async get() {
				return null;
			},
			async list() {
				pagesRead += 1;
				return {
					items: [
						contentItem("courses", `course-${String(pagesRead).padStart(3, "0")}`, {
							title: `Course ${pagesRead}`,
						}),
					],
					hasMore: pagesRead <= 100,
					...(pagesRead <= 100 ? { cursor: `page-${pagesRead + 1}` } : {}),
				};
			},
		};

		await expect(listPublishedCourses(fixture.ctx, {})).rejects.toMatchObject({
			code: "LEARN_CONTENT_SCALE_LIMIT",
			status: 503,
		});
		expect(pagesRead).toBe(100);
	});

	it("rejects a malformed catalog cursor instead of silently restarting pagination", async () => {
		const fixture = createContext({ contentPageSize: 1 });
		fixture.add(contentItem("courses", "course-a", { title: "Alpha" }));
		fixture.add(contentItem("courses", "course-b", { title: "Bravo" }));

		await expect(
			listPublishedCourses(fixture.ctx, { cursor: "not-a-catalog-cursor", limit: 1 }),
		).rejects.toMatchObject({
			code: "LEARN_CATALOG_CURSOR_INVALID",
			status: 400,
		});
	});

	it("fails closed when the Lesson projection pagination cannot continue", async () => {
		const fixture = createContext();
		const course = fixture.add(contentItem("courses", "course-public", { title: "Public course" }));
		const lesson = fixture.add(
			contentItem("lessons", "lesson-first", {
				title: "First lesson",
				course: course.id,
				order: 1,
			}),
		);
		const rows = new Map<string, IndexRow>([
			[
				"pointer",
				{
					courseId: course.id,
					stepType: "lesson",
					stepId: lesson.id,
					order: 1,
					status: "published",
				},
			],
		]);
		const brokenIndex = storageCollection(rows);
		brokenIndex.query = async () => ({
			items: [{ id: "pointer", data: rows.get("pointer")! }],
			hasMore: true,
		});
		fixture.ctx.storage["course_content_index"] = brokenIndex;

		await expect(getPublishedCourse(fixture.ctx, { courseId: course.id })).rejects.toMatchObject({
			code: "LEARN_INDEX_PAGINATION_INVALID",
			status: 503,
		});
	});

	it("fails closed when direct Lesson lookup cannot finish scanning its projection", async () => {
		const fixture = createContext();
		const course = fixture.add(contentItem("courses", "course-public", { title: "Public course" }));
		const lesson = fixture.add(
			contentItem("lessons", "lesson-target", {
				title: "Target lesson",
				course: course.id,
				order: 2,
			}),
		);
		const rows = new Map<string, IndexRow>([
			[
				"other-pointer",
				{
					courseId: course.id,
					stepType: "lesson",
					stepId: "lesson-other",
					order: 1,
					status: "published",
				},
			],
		]);
		const brokenIndex = storageCollection(rows);
		brokenIndex.query = async () => ({
			items: [{ id: "other-pointer", data: rows.get("other-pointer")! }],
			hasMore: true,
		});
		fixture.ctx.storage["course_content_index"] = brokenIndex;

		await expect(getPublishedLesson(fixture.ctx, lesson.id)).rejects.toMatchObject({
			code: "LEARN_INDEX_PAGINATION_INVALID",
			status: 503,
		});
	});
});

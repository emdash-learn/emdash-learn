import { describe, expect, it, vi } from "vitest";
import type {
	ContentItem,
	ContentListOptions,
	PluginContext,
	QueryOptions,
	StorageCollection,
} from "emdash";

import { getPublishedCourse } from "../../../src/modules/published-courses.js";
import { backfillContentIndex } from "../../../src/reconcilers/backfill-content-index.js";

type IndexRow = Record<string, unknown>;

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

function createFixture(pageSize = 1) {
	const collections = new Map<string, Map<string, ContentItem>>([
		["courses", new Map()],
		["lessons", new Map()],
	]);
	const indexRows = new Map<string, IndexRow>();
	const warn = vi.fn();
	const info = vi.fn();

	const index: StorageCollection<IndexRow> = {
		async get(id) {
			return indexRows.get(id) ?? null;
		},
		async put(id, data) {
			const duplicateStep = [...indexRows.entries()].find(
				([existingId, existing]) =>
					existingId !== id &&
					typeof data["stepId"] === "string" &&
					existing["stepId"] === data["stepId"],
			);
			if (duplicateStep) {
				throw new Error(`Unique stepId conflict with ${duplicateStep[0]}.`);
			}
			indexRows.set(id, structuredClone(data));
		},
		async delete(id) {
			return indexRows.delete(id);
		},
		async exists(id) {
			return indexRows.has(id);
		},
		async getMany(ids) {
			return new Map(ids.flatMap((id) => (indexRows.has(id) ? [[id, indexRows.get(id)!]] : [])));
		},
		async putMany(items) {
			for (const item of items) indexRows.set(item.id, structuredClone(item.data));
		},
		async deleteMany(ids) {
			let deleted = 0;
			for (const id of ids) {
				if (indexRows.delete(id)) deleted += 1;
			}
			return deleted;
		},
		async query(options: QueryOptions = {}) {
			const matching = [...indexRows.entries()].filter(([, row]) =>
				Object.entries(options.where ?? {}).every(([field, expected]) => row[field] === expected),
			);
			// oxlint-disable-next-line no-array-sort -- sorting a local fixture copy
			matching.sort(([left], [right]) => left.localeCompare(right));
			const offset = options.cursor ? Number(options.cursor) : 0;
			const limit = Math.min(options.limit ?? matching.length, pageSize);
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
				return {
					items,
					hasMore,
					...(hasMore ? { cursor: String(nextOffset) } : {}),
				};
			},
		},
		log: { debug: vi.fn(), info, warn, error: vi.fn() },
	} as unknown as PluginContext;

	return {
		ctx,
		indexRows,
		warn,
		info,
		add(item: ContentItem) {
			collections.get(item.type)?.set(item.id, item);
			return item;
		},
	};
}

describe("backfillContentIndex", () => {
	it("rebuilds the Lesson projection and removes stale rows across storage pages", async () => {
		const fixture = createFixture(1);
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

		fixture.indexRows.set("01-old-assignment", {
			courseId: "course-old",
			stepType: "lesson",
			stepId: "lesson-moved",
			order: 2,
			status: "published",
		});
		fixture.indexRows.set("02-deleted", {
			courseId: "course-old",
			stepType: "lesson",
			stepId: "lesson-deleted",
			order: 4,
			status: "published",
		});
		fixture.indexRows.set("03-draft", {
			courseId: "course-old",
			stepType: "lesson",
			stepId: "lesson-draft",
			order: 3,
			status: "published",
		});
		fixture.indexRows.set("04-topic", {
			courseId: "course-old",
			stepType: "topic",
			stepId: "topic-legacy",
			order: 5,
			status: "published",
		});

		const summary = await backfillContentIndex(fixture.ctx);
		const oldCourse = await getPublishedCourse(fixture.ctx, { courseId: "course-old" });
		const newCourse = await getPublishedCourse(fixture.ctx, { courseId: "course-new" });

		expect({ summary, oldCourse, newCourse }).toEqual({
			summary: {
				lessonsUpserted: 2,
				staleRowsDeleted: 4,
				errors: 0,
			},
			oldCourse: {
				course: expect.objectContaining({ id: "course-old" }),
				lessons: [],
			},
			newCourse: {
				course: expect.objectContaining({ id: "course-new" }),
				lessons: [
					{
						id: "lesson-moved",
						slug: "lesson-moved",
						title: "Moved lesson",
						order: 2,
						publishedAt: "2026-01-03T00:00:00.000Z",
					},
				],
			},
		});
	});

	it("reports malformed published Lessons instead of manufacturing projection defaults", async () => {
		const fixture = createFixture(2);
		fixture.add(contentItem("courses", "course-safe", { title: "Safe course" }));
		fixture.add(
			contentItem("lessons", "lesson-valid", {
				title: "Valid lesson",
				course: "course-safe",
				order: 1,
			}),
		);
		fixture.add(
			contentItem("lessons", "lesson-missing-order", {
				title: "Missing order",
				course: "course-safe",
			}),
		);
		fixture.add(
			contentItem("lessons", "lesson-blank-title", {
				title: "",
				course: "course-safe",
				order: 2,
			}),
		);
		fixture.add(
			contentItem("lessons", "lesson-orphan", {
				title: "Missing Course",
				order: 3,
			}),
		);

		const summary = await backfillContentIndex(fixture.ctx);
		const course = await getPublishedCourse(fixture.ctx, { courseId: "course-safe" });

		expect({ summary, course }).toEqual({
			summary: {
				lessonsUpserted: 1,
				staleRowsDeleted: 0,
				errors: 3,
			},
			course: {
				course: expect.objectContaining({ id: "course-safe" }),
				lessons: [
					{
						id: "lesson-valid",
						slug: "lesson-valid",
						title: "Valid lesson",
						order: 1,
						publishedAt: "2026-01-03T00:00:00.000Z",
					},
				],
			},
		});
	});

	it("leaves the projection untouched when authoritative pagination is incomplete", async () => {
		const fixture = createFixture();
		fixture.add(contentItem("courses", "course-safe", { title: "Safe course" }));
		const existingLesson = fixture.add(
			contentItem("lessons", "lesson-existing", {
				title: "Existing lesson",
				course: "course-safe",
				order: 1,
			}),
		);
		const untrustedPartialLesson = contentItem("lessons", "lesson-partial", {
			title: "Partial page lesson",
			course: "course-safe",
			order: 2,
		});
		fixture.indexRows.set("existing-pointer", {
			courseId: "course-safe",
			stepType: "lesson",
			stepId: existingLesson.id,
			order: 1,
			status: "published",
		});
		const get = fixture.ctx.content!.get.bind(fixture.ctx.content);
		fixture.ctx.content = {
			get,
			async list() {
				return {
					items: [untrustedPartialLesson],
					hasMore: true,
				};
			},
		};

		const summary = await backfillContentIndex(fixture.ctx);
		const course = await getPublishedCourse(fixture.ctx, { courseId: "course-safe" });

		expect({ summary, course }).toEqual({
			summary: {
				lessonsUpserted: 0,
				staleRowsDeleted: 0,
				errors: 1,
			},
			course: {
				course: expect.objectContaining({ id: "course-safe" }),
				lessons: [
					{
						id: "lesson-existing",
						slug: "lesson-existing",
						title: "Existing lesson",
						order: 1,
						publishedAt: "2026-01-03T00:00:00.000Z",
					},
				],
			},
		});
	});

	it("stops authoritative rebuild scans at the explicit source-page limit before writing", async () => {
		const fixture = createFixture();
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
					hasMore: pagesRead <= 100,
					...(pagesRead <= 100 ? { cursor: `page-${pagesRead + 1}` } : {}),
				};
			},
		};

		await expect(backfillContentIndex(fixture.ctx)).resolves.toEqual({
			lessonsUpserted: 0,
			staleRowsDeleted: 0,
			errors: 1,
		});
		expect(pagesRead).toBe(100);
	});

	it("does not reconcile against an incomplete scan of the existing projection", async () => {
		const fixture = createFixture();
		fixture.add(contentItem("courses", "course-safe", { title: "Safe course" }));
		fixture.add(
			contentItem("lessons", "lesson-a", {
				title: "Lesson A",
				course: "course-safe",
				order: 1,
			}),
		);
		fixture.add(
			contentItem("lessons", "lesson-b", {
				title: "Lesson B",
				course: "course-safe",
				order: 2,
			}),
		);
		fixture.indexRows.set("pointer-a", {
			courseId: "course-safe",
			stepType: "lesson",
			stepId: "lesson-a",
			order: 1,
			status: "published",
		});
		fixture.indexRows.set("pointer-b", {
			courseId: "course-safe",
			stepType: "lesson",
			stepId: "lesson-b",
			order: 2,
			status: "published",
		});
		const index = fixture.ctx.storage["course_content_index"];
		index.query = async () => ({
			items: [{ id: "pointer-a", data: fixture.indexRows.get("pointer-a")! }],
			hasMore: true,
		});

		await expect(backfillContentIndex(fixture.ctx)).resolves.toEqual({
			lessonsUpserted: 0,
			staleRowsDeleted: 0,
			errors: 1,
		});
	});
});

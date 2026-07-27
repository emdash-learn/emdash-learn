/* oxlint-disable typescript-eslint/no-unsafe-type-assertion -- route integration fixtures intentionally erase generic host types at the invocation boundary */
import { describe, expect, it } from "vitest";
import type { PluginContext, QueryOptions, StorageCollection } from "emdash";

import { publishedCourseRoutes } from "../../../src/routes/published-courses.js";
import { BOOTSTRAP_VERSION } from "../../../src/constants.js";
import { BOOTSTRAP_STATE_KEY } from "../../../src/kv-keys.js";
import type { CourseContentIndexRow } from "../../../src/types/storage.js";

type RuntimeContentItem = NonNullable<
	Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>
>;
type RuntimeContentListOptions = NonNullable<
	Parameters<NonNullable<PluginContext["content"]>["list"]>[1]
>;

interface TestFixture {
	ctx: PluginContext;
	addContent: (
		collection: "courses" | "lessons",
		input: {
			id: string;
			slug?: string;
			status?: "draft" | "published";
			data: Record<string, unknown>;
		},
	) => RuntimeContentItem;
	addIndex: (id: string, data: CourseContentIndexRow) => void;
}

function makeStorageCollection<T>(rows: Map<string, T>): StorageCollection<T> {
	return {
		async get(id) {
			return rows.get(id) ?? null;
		},
		async put(id, data) {
			rows.set(id, data);
		},
		async delete(id) {
			return rows.delete(id);
		},
		async exists(id) {
			return rows.has(id);
		},
		async getMany(ids) {
			return new Map(ids.flatMap((id) => (rows.has(id) ? [[id, rows.get(id) as T]] : [])));
		},
		async putMany(items) {
			for (const item of items) rows.set(item.id, item.data);
		},
		async deleteMany(ids) {
			let deleted = 0;
			for (const id of ids) {
				if (rows.delete(id)) deleted += 1;
			}
			return deleted;
		},
		async query(options: QueryOptions = {}) {
			const matches = [...rows.entries()].filter(([, data]) => {
				if (!options.where) return true;
				const record = data as Record<string, unknown>;
				return Object.entries(options.where).every(([key, value]) => record[key] === value);
			});
			return {
				items: matches.map(([id, data]) => ({ id, data })),
				hasMore: false,
			};
		},
		async count(where) {
			const page = await this.query({ where });
			return page.items.length;
		},
	};
}

function createFixture(): TestFixture {
	const collections = new Map<string, Map<string, RuntimeContentItem>>([
		["courses", new Map()],
		["lessons", new Map()],
	]);
	const indexRows = new Map<string, CourseContentIndexRow>();

	const ctx = {
		plugin: { id: "lms-core", version: "test" },
		storage: {
			course_content_index: makeStorageCollection(indexRows),
		},
		kv: {
			async get<T>(key: string): Promise<T | null> {
				if (key !== BOOTSTRAP_STATE_KEY) return null;
				return {
					version: BOOTSTRAP_VERSION,
					completedSteps: [],
					verification: {
						contractVersion: BOOTSTRAP_VERSION,
						schema: "compatible",
						projection: "repaired",
					},
				} as T;
			},
			async set() {},
			async delete() {
				return false;
			},
			async list() {
				return [];
			},
		},
		content: {
			async get(collection: string, id: string) {
				return collections.get(collection)?.get(id) ?? null;
			},
			async list(collection: string, options: RuntimeContentListOptions = {}) {
				const filtered = [...(collections.get(collection)?.values() ?? [])].filter(
					(item) => !options.where?.status || item.status === options.where.status,
				);
				// oxlint-disable-next-line no-array-sort -- sorting a local test-fixture copy
				const source = [...filtered].sort((left, right) => left.id.localeCompare(right.id));
				const offset = options.cursor ? Number(options.cursor) : 0;
				const limit = options.limit ?? 50;
				const items = source.slice(offset, offset + limit);
				const nextOffset = offset + items.length;
				const hasMore = nextOffset < source.length;
				return {
					items,
					hasMore,
					...(hasMore ? { cursor: String(nextOffset) } : {}),
				};
			},
		},
		log: {
			debug() {},
			info() {},
			warn() {},
			error() {},
		},
		site: { name: "Test", url: "https://example.test", locale: "en" },
		url: (path: string) => new URL(path, "https://example.test").toString(),
	} as unknown as PluginContext;

	return {
		ctx,
		addContent(collection, input) {
			const item: RuntimeContentItem = {
				id: input.id,
				type: collection,
				slug: input.slug ?? input.id,
				status: input.status ?? "draft",
				locale: "en",
				data: input.data,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				publishedAt: (input.status ?? "draft") === "published" ? "2026-01-01T00:00:00.000Z" : null,
			};
			collections.get(collection)?.set(item.id, item);
			return item;
		},
		addIndex(id, data) {
			indexRows.set(id, data);
		},
	};
}

async function callRoute(
	fixture: TestFixture,
	name: keyof typeof publishedCourseRoutes,
	input: unknown,
): Promise<unknown> {
	const route = publishedCourseRoutes[name];
	const validated = route.input?.parse(input) ?? input;
	return route.handler({ ...fixture.ctx, input: validated } as never);
}

describe("published course routes", () => {
	it("rejects unknown identity claims and unbounded public lookup values", () => {
		expect(
			publishedCourseRoutes.catalog.input?.safeParse({
				learnerId: "attacker-selected",
			}).success,
		).toBe(false);
		expect(
			publishedCourseRoutes["course:get"].input?.safeParse({
				courseId: "course-public",
				userId: "attacker-selected",
			}).success,
		).toBe(false);
		expect(
			publishedCourseRoutes["lesson:get"].input?.safeParse({
				lessonId: "x".repeat(201),
			}).success,
		).toBe(false);
	});

	it("catalog exposes only published courses matching its public filters", async () => {
		const fixture = createFixture();
		const published = fixture.addContent("courses", {
			id: "course-public",
			status: "published",
			data: {
				title: "Public TypeScript",
				difficulty: "beginner",
				cover_image: {
					id: "media-cover",
					provider: "local",
					src: "/_emdash/api/media/file/cover.webp",
					alt: "Course cover",
					width: 1200,
					height: 630,
					filename: "cover.webp",
					meta: { privateProviderValue: "must not leak" },
				},
			},
		});
		fixture.addContent("courses", {
			id: "course-draft",
			data: { title: "Draft TypeScript", difficulty: "beginner" },
		});
		fixture.addContent("courses", {
			id: "course-advanced",
			status: "published",
			data: { title: "Public TypeScript Advanced", difficulty: "advanced" },
		});

		const result = (await callRoute(fixture, "catalog", {
			search: "typescript",
			difficulty: "beginner",
		})) as {
			items: Array<{ id: string; coverImage?: unknown }>;
			hasMore: boolean;
		};

		expect(publishedCourseRoutes.catalog.public).toBe(true);
		expect(result).toEqual({
			items: [
				expect.objectContaining({
					id: published.id,
					coverImage: {
						id: "media-cover",
						provider: "local",
						src: "/_emdash/api/media/file/cover.webp",
						alt: "Course cover",
						width: 1200,
						height: 630,
					},
				}),
			],
			hasMore: false,
		});
	});

	it("catalog paginates in deterministic title order", async () => {
		const fixture = createFixture();
		fixture.addContent("courses", {
			id: "course-charlie",
			status: "published",
			data: { title: "Charlie" },
		});
		fixture.addContent("courses", {
			id: "course-alpha",
			status: "published",
			data: { title: "Alpha" },
		});
		fixture.addContent("courses", {
			id: "course-bravo",
			status: "published",
			data: { title: "Bravo" },
		});

		const first = (await callRoute(fixture, "catalog", { limit: 2 })) as {
			items: Array<{ title: string }>;
			cursor?: string;
			hasMore: boolean;
		};
		const second = (await callRoute(fixture, "catalog", {
			limit: 2,
			cursor: first.cursor,
		})) as {
			items: Array<{ title: string }>;
			hasMore: boolean;
		};

		expect(first).toMatchObject({
			items: [{ title: "Alpha" }, { title: "Bravo" }],
			hasMore: true,
		});
		expect(first.cursor).toBeDefined();
		expect(second).toEqual({
			items: [expect.objectContaining({ title: "Charlie" })],
			hasMore: false,
		});
	});

	it("course:get resolves a published slug and orders only its published lessons", async () => {
		const fixture = createFixture();
		const course = fixture.addContent("courses", {
			id: "course-typescript",
			slug: "typescript",
			status: "published",
			data: {
				title: "TypeScript",
				subtitle: "From types to production",
				description: "A practical course.",
			},
		});
		const later = fixture.addContent("lessons", {
			id: "lesson-later",
			status: "published",
			data: { title: "Narrowing", course: course.id, order: 20 },
		});
		const earlier = fixture.addContent("lessons", {
			id: "lesson-earlier",
			status: "published",
			data: { title: "Types", course: course.id, order: 10 },
		});
		const sameOrder = fixture.addContent("lessons", {
			id: "lesson-alpha",
			status: "published",
			data: { title: "A deterministic tie", course: course.id, order: 10 },
		});
		const staleDraft = fixture.addContent("lessons", {
			id: "lesson-draft",
			data: { title: "Unreleased", course: course.id, order: 0 },
		});
		fixture.addIndex("idx-later", {
			courseId: course.id,
			stepType: "lesson",
			stepId: later.id,
			order: 20,
			status: "published",
		});
		fixture.addIndex("idx-earlier", {
			courseId: course.id,
			stepType: "lesson",
			stepId: earlier.id,
			order: 10,
			status: "published",
		});
		fixture.addIndex("idx-same-order", {
			courseId: course.id,
			stepType: "lesson",
			stepId: sameOrder.id,
			order: 10,
			status: "published",
		});
		// A stale projection row must not make a draft lesson public.
		fixture.addIndex("idx-stale-draft", {
			courseId: course.id,
			stepType: "lesson",
			stepId: staleDraft.id,
			order: 0,
			status: "published",
		});

		const result = (await callRoute(fixture, "course:get", {
			slug: "typescript",
		})) as {
			course: { id: string; title: string };
			lessons: Array<{ id: string; order: number }>;
		};

		expect(publishedCourseRoutes["course:get"].public).toBe(true);
		expect(result.course).toMatchObject({
			id: course.id,
			title: "TypeScript",
		});
		expect(result.lessons).toEqual([
			expect.objectContaining({ id: sameOrder.id, order: 10 }),
			expect.objectContaining({ id: earlier.id, order: 10 }),
			expect.objectContaining({ id: later.id, order: 20 }),
		]);
	});

	it("course:get never exposes a draft course by id or slug", async () => {
		const fixture = createFixture();
		const draft = fixture.addContent("courses", {
			id: "course-draft",
			slug: "draft-course",
			data: { title: "Draft course" },
		});

		await expect(callRoute(fixture, "course:get", { courseId: draft.id })).rejects.toMatchObject({
			status: 404,
			code: "LEARN_COURSE_NOT_FOUND",
		});
		await expect(callRoute(fixture, "course:get", { slug: "draft-course" })).rejects.toMatchObject({
			status: 404,
			code: "LEARN_COURSE_NOT_FOUND",
		});
	});

	it("lesson:get returns the full published lesson when its course is published", async () => {
		const fixture = createFixture();
		const course = fixture.addContent("courses", {
			id: "course-public",
			status: "published",
			data: { title: "Public course" },
		});
		const body = [{ _type: "block", children: [{ _type: "span", text: "Lesson body" }] }];
		const lesson = fixture.addContent("lessons", {
			id: "lesson-public",
			slug: "lesson-public",
			status: "published",
			data: {
				title: "Published lesson",
				course: course.id,
				order: 4,
				summary: "The complete lesson.",
				body,
				video_url: "https://video.example/lesson",
				duration_seconds: 420,
			},
		});
		fixture.addIndex("idx-public-lesson", {
			courseId: course.id,
			stepType: "lesson",
			stepId: lesson.id,
			order: 4,
			status: "published",
		});

		const result = (await callRoute(fixture, "lesson:get", {
			lessonId: lesson.id,
		})) as {
			lesson: {
				id: string;
				courseId: string;
				order: number;
				body: unknown;
			};
		};

		expect(publishedCourseRoutes["lesson:get"].public).toBe(true);
		expect(result.lesson).toMatchObject({
			id: lesson.id,
			courseId: course.id,
			order: 4,
			body,
		});
	});

	it("lesson:get never exposes a draft lesson or a lesson under a draft course", async () => {
		const fixture = createFixture();
		const publishedCourse = fixture.addContent("courses", {
			id: "course-public",
			status: "published",
			data: { title: "Public course" },
		});
		const draftCourse = fixture.addContent("courses", {
			id: "course-draft",
			data: { title: "Draft course" },
		});
		const draftLesson = fixture.addContent("lessons", {
			id: "lesson-draft",
			data: { title: "Draft lesson", course: publishedCourse.id, order: 1 },
		});
		const hiddenByParent = fixture.addContent("lessons", {
			id: "lesson-hidden-by-parent",
			status: "published",
			data: { title: "Hidden lesson", course: draftCourse.id, order: 1 },
		});
		fixture.addIndex("idx-draft-lesson", {
			courseId: publishedCourse.id,
			stepType: "lesson",
			stepId: draftLesson.id,
			order: 1,
			status: "published",
		});
		fixture.addIndex("idx-hidden-by-parent", {
			courseId: draftCourse.id,
			stepType: "lesson",
			stepId: hiddenByParent.id,
			order: 1,
			status: "published",
		});

		await expect(
			callRoute(fixture, "lesson:get", { lessonId: draftLesson.id }),
		).rejects.toMatchObject({
			status: 404,
			code: "LEARN_LESSON_NOT_FOUND",
		});
		await expect(
			callRoute(fixture, "lesson:get", { lessonId: hiddenByParent.id }),
		).rejects.toMatchObject({
			status: 404,
			code: "LEARN_LESSON_NOT_FOUND",
		});
	});
});

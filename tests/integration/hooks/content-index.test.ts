import { describe, expect, it, vi } from "vitest";
import type { PluginContext, QueryOptions, StorageCollection } from "emdash";

import {
	contentAfterDelete,
	contentAfterPublish,
	contentAfterSave,
	contentAfterUnpublish,
} from "../../../src/hooks/content.js";
import type { CourseContentIndexRow } from "../../../src/types/storage.js";

function createIndexCollection(
	rows: Map<string, CourseContentIndexRow>,
): StorageCollection<CourseContentIndexRow> {
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
			let count = 0;
			for (const id of ids) {
				if (rows.delete(id)) count += 1;
			}
			return count;
		},
		async query(options: QueryOptions = {}) {
			const items = [...rows].filter(([, row]) =>
				Object.entries(options.where ?? {}).every(
					([field, expected]) => Reflect.get(row, field) === expected,
				),
			);
			return {
				items: items.map(([id, data]) => ({ id, data })),
				hasMore: false,
			};
		},
		async count(where) {
			return (await this.query({ where })).items.length;
		},
	};
}

function createContext(
	contentItems: Array<{
		id: string;
		status: "draft" | "published";
		data: Record<string, unknown>;
	}> = [],
) {
	const rows = new Map<string, CourseContentIndexRow>();
	const contentById = new Map(contentItems.map((item) => [item.id, item]));
	// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- intentionally minimal PluginContext integration fixture
	const ctx = {
		storage: { course_content_index: createIndexCollection(rows) },
		content: {
			async get(_collection: string, id: string) {
				return contentById.get(id) ?? null;
			},
			async list() {
				return {
					items: [...contentById.values()].filter((item) => item.status === "published"),
					hasMore: false,
				};
			},
		},
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as PluginContext;
	return { ctx, rows, contentById };
}

const lesson = (
	id: string,
	courseId: string,
	order: number,
	status: "draft" | "published" = "published",
) => ({
	id,
	status,
	data: { title: id, course: courseId, order },
});

describe("published lesson projection", () => {
	it("upserts published lessons and moves a reassigned lesson without leaving a stale row", async () => {
		const fixture = createContext([lesson("lesson-1", "course-a", 2)]);

		await contentAfterPublish(
			{ collection: "lessons", content: lesson("lesson-1", "payload-course", 99) },
			fixture.ctx,
		);
		expect([...fixture.rows.values()]).toEqual([
			{
				courseId: "course-a",
				stepType: "lesson",
				stepId: "lesson-1",
				order: 2,
				status: "published",
			},
		]);

		fixture.contentById.set("lesson-1", lesson("lesson-1", "course-b", 7));
		await contentAfterSave(
			{
				collection: "lessons",
				isNew: false,
				content: lesson("lesson-1", "payload-course", 99),
			},
			fixture.ctx,
		);
		expect([...fixture.rows.values()]).toEqual([
			expect.objectContaining({
				courseId: "course-b",
				stepId: "lesson-1",
				order: 7,
			}),
		]);
	});

	it("removes pointers on draft save, unpublish, and delete while ignoring other collections", async () => {
		const fixture = createContext([lesson("lesson-1", "course-a", 1)]);
		await contentAfterPublish(
			{ collection: "lessons", content: lesson("lesson-1", "course-a", 1) },
			fixture.ctx,
		);

		fixture.contentById.set("lesson-1", lesson("lesson-1", "course-a", 1, "draft"));
		await contentAfterSave(
			{
				collection: "lessons",
				isNew: false,
				content: lesson("lesson-1", "course-a", 1, "draft"),
			},
			fixture.ctx,
		);
		expect(fixture.rows.size).toBe(0);

		fixture.contentById.set("lesson-1", lesson("lesson-1", "course-a", 1));
		await contentAfterPublish(
			{ collection: "lessons", content: lesson("lesson-1", "course-a", 1) },
			fixture.ctx,
		);
		fixture.contentById.set("lesson-1", lesson("lesson-1", "course-a", 1, "draft"));
		await contentAfterUnpublish(
			{ collection: "lessons", content: lesson("lesson-1", "course-a", 1, "draft") },
			fixture.ctx,
		);
		expect(fixture.rows.size).toBe(0);

		fixture.contentById.set("lesson-1", lesson("lesson-1", "course-a", 1));
		await contentAfterPublish(
			{ collection: "lessons", content: lesson("lesson-1", "course-a", 1) },
			fixture.ctx,
		);
		fixture.contentById.delete("lesson-1");
		await contentAfterDelete(
			{ collection: "lessons", id: "lesson-1", permanent: true },
			fixture.ctx,
		);
		expect(fixture.rows.size).toBe(0);

		await contentAfterPublish(
			{ collection: "posts", content: lesson("post-1", "course-a", 1) },
			fixture.ctx,
		);
		expect(fixture.rows.size).toBe(0);
	});
});

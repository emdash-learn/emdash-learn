import type {
	ContentDeleteEvent,
	ContentHookEvent,
	ContentPublishStateChangeEvent,
	PluginContext,
	StorageCollection,
} from "emdash";

import { LESSONS_COLLECTION_SLUG } from "../constants.js";
import type { CourseContentIndexRow } from "../types/storage.js";

const CONTENT_INDEX_COLLECTION = "course_content_index";

function indexStore(ctx: PluginContext): StorageCollection {
	const collection = ctx.storage[CONTENT_INDEX_COLLECTION];
	if (!collection) {
		throw new Error(`Plugin storage collection "${CONTENT_INDEX_COLLECTION}" is not declared.`);
	}
	return collection;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function contentIndexId(courseId: string, lessonId: string): string {
	return `idx__${courseId}__lesson__${lessonId}`;
}

export async function indexPublishedLesson(
	ctx: PluginContext,
	content: Record<string, unknown>,
): Promise<boolean> {
	const lessonId = stringField(content["id"]);
	const data = content["data"];
	const courseId =
		typeof data === "object" && data !== null
			? stringField(Reflect.get(data, "course"))
			: undefined;
	if (!lessonId || !courseId) return false;

	// A lesson may be reassigned to another course. Remove any prior pointer so
	// one lesson can never appear in two outlines after that move.
	await removeLessonFromIndex(ctx, lessonId);

	const row: CourseContentIndexRow = {
		courseId,
		stepType: "lesson",
		stepId: lessonId,
		order:
			typeof data === "object" && data !== null
				? (numberField(Reflect.get(data, "order")) ?? 0)
				: 0,
		status: "published",
	};
	await indexStore(ctx).put(contentIndexId(courseId, lessonId), row);
	return true;
}

export async function removeLessonFromIndex(ctx: PluginContext, lessonId: string): Promise<number> {
	const store = indexStore(ctx);
	let cursor: string | undefined;
	let removed = 0;

	/* oxlint-disable no-await-in-loop -- storage pagination is sequential */
	do {
		const page = await store.query({
			where: { stepType: "lesson", stepId: lessonId },
			limit: 100,
			cursor,
		});
		for (const row of page.items) {
			await store.delete(row.id);
			removed += 1;
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */

	return removed;
}

/** Refresh the projection when an already-published lesson is edited. */
export async function contentAfterSave(event: ContentHookEvent, ctx: PluginContext): Promise<void> {
	if (event.collection !== LESSONS_COLLECTION_SLUG) return;
	const lessonId = stringField(event.content["id"]);
	if (!lessonId) return;

	if (event.content["status"] === "published") {
		await indexPublishedLesson(ctx, event.content);
		return;
	}
	await removeLessonFromIndex(ctx, lessonId);
}

export async function contentAfterPublish(
	event: ContentPublishStateChangeEvent,
	ctx: PluginContext,
): Promise<void> {
	if (event.collection !== LESSONS_COLLECTION_SLUG) return;
	await indexPublishedLesson(ctx, event.content);
}

export async function contentAfterUnpublish(
	event: ContentPublishStateChangeEvent,
	ctx: PluginContext,
): Promise<void> {
	if (event.collection !== LESSONS_COLLECTION_SLUG) return;
	const lessonId = stringField(event.content["id"]);
	if (lessonId) await removeLessonFromIndex(ctx, lessonId);
}

export async function contentAfterDelete(
	event: ContentDeleteEvent,
	ctx: PluginContext,
): Promise<void> {
	if (event.collection !== LESSONS_COLLECTION_SLUG) return;
	await removeLessonFromIndex(ctx, event.id);
}

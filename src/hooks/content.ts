import type {
	ContentDeleteEvent,
	ContentHookEvent,
	ContentPublishStateChangeEvent,
	PluginContext,
} from "emdash";

import { LESSONS_COLLECTION_SLUG } from "../constants.js";
import { synchronizePublishedLesson } from "../modules/published-lessons.js";

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Refresh the projection when an already-published lesson is edited. */
export async function contentAfterSave(event: ContentHookEvent, ctx: PluginContext): Promise<void> {
	if (event.collection !== LESSONS_COLLECTION_SLUG) return;
	const lessonId = stringField(event.content["id"]);
	if (!lessonId) return;
	await synchronizePublishedLesson(ctx, lessonId);
}

export async function contentAfterPublish(
	event: ContentPublishStateChangeEvent,
	ctx: PluginContext,
): Promise<void> {
	if (event.collection !== LESSONS_COLLECTION_SLUG) return;
	const lessonId = stringField(event.content["id"]);
	if (lessonId) await synchronizePublishedLesson(ctx, lessonId);
}

export async function contentAfterUnpublish(
	event: ContentPublishStateChangeEvent,
	ctx: PluginContext,
): Promise<void> {
	if (event.collection !== LESSONS_COLLECTION_SLUG) return;
	const lessonId = stringField(event.content["id"]);
	if (lessonId) await synchronizePublishedLesson(ctx, lessonId);
}

export async function contentAfterDelete(
	event: ContentDeleteEvent,
	ctx: PluginContext,
): Promise<void> {
	if (event.collection !== LESSONS_COLLECTION_SLUG) return;
	await synchronizePublishedLesson(ctx, event.id);
}

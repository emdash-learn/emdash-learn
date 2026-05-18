/**
 * backfill-content-index reconciler (AUDIT C3).
 *
 * Seeds the `course_content_index` projection for existing installs. On a
 * fresh install this runs once via the setup wizard (step `seed-content-index`,
 * BOOTSTRAP_VERSION 3). On daily cron it sweeps for drift and fills any gaps
 * left by missed `content:afterSave` events.
 *
 * Guarantees:
 *   - Idempotent: the uniqueIndex on `(courseId, stepType, stepId)` means a
 *     second put of the same row is a no-op at the storage level; we
 *     `put` unconditionally rather than checking-then-writing.
 *   - Per-item try/catch: one bad row never aborts the full sweep.
 *   - Single content.list scan per step type (acceptable for a backfill
 *     reconciler; not for hot curriculum/progress paths).
 *
 * Returns `Result<{ lessonsUpserted, topicsUpserted, errors }>`.
 */

import type { PluginContext, StorageCollection } from "emdash";

import { LESSONS_COLLECTION_SLUG, TOPICS_COLLECTION_SLUG } from "../constants.js";
import { ok, type Result } from "../engine/result.js";
import type { CourseContentIndexRow } from "../types/storage.js";

export interface BackfillSummary {
	lessonsUpserted: number;
	topicsUpserted: number;
	errors: number;
	/** Forwarded by the cron dispatcher as `processed` for uniform log shape. */
	processed: number;
	/** Forwarded by the cron dispatcher as `skipped` for uniform log shape. */
	skipped: number;
}

const PAGE_SIZE = 100;
const CONTENT_INDEX_COLLECTION = "course_content_index";

function contentIndexStore(ctx: PluginContext): StorageCollection<CourseContentIndexRow> {
	const store = (ctx.storage as Record<string, StorageCollection | undefined>)[
		CONTENT_INDEX_COLLECTION
	];
	if (!store) {
		throw new Error(
			`backfill-content-index: ctx.storage.${CONTENT_INDEX_COLLECTION} is not declared on the descriptor.`,
		);
	}
	return store as StorageCollection<CourseContentIndexRow>;
}

function contentIndexId(courseId: string, stepType: "lesson" | "topic", stepId: string): string {
	return `idx__${courseId}__${stepType}__${stepId}`;
}

function fieldNum(data: Record<string, unknown>, key: string): number | undefined {
	const v = data[key];
	return typeof v === "number" ? v : undefined;
}

function fieldBool(data: Record<string, unknown>, key: string): boolean | undefined {
	const v = data[key];
	if (typeof v === "boolean") return v;
	if (v === 1) return true;
	if (v === 0) return false;
	return undefined;
}

function fieldStr(data: Record<string, unknown>, key: string): string | undefined {
	const v = data[key];
	return typeof v === "string" && v ? v : undefined;
}

async function backfillLessons(
	ctx: PluginContext,
	summary: BackfillSummary,
): Promise<void> {
	if (!ctx.content) return;
	const store = contentIndexStore(ctx);
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await ctx.content.list(LESSONS_COLLECTION_SLUG, {
			where: { status: "published" },
			limit: PAGE_SIZE,
			cursor,
		});
		for (const item of page.items) {
			const courseId = fieldStr(item.data as Record<string, unknown>, "course");
			if (!courseId) {
				summary.errors += 1;
				ctx.log.warn("backfill-content-index: lesson missing course ref", {
					lessonId: item.id,
				});
				continue;
			}
			try {
				const data = item.data as Record<string, unknown>;
				const row: CourseContentIndexRow = {
					courseId,
					stepType: "lesson",
					stepId: item.id,
					order: fieldNum(data, "order") ?? 0,
					status: "published",
				};
				if (item.publishedAt) row.publishedAt = item.publishedAt;
				// scheduledAt is available on the internal ContentItem but not on the
				// public ContentItem interface; access via cast for the backfill path.
				const scheduledAt = (item as unknown as Record<string, unknown>)["scheduledAt"];
				if (typeof scheduledAt === "string") row.scheduledAt = scheduledAt;
				const dur = fieldNum(data, "duration_seconds");
				if (dur !== undefined) row.durationSeconds = dur;
				const isPreview = fieldBool(data, "is_preview");
				if (isPreview !== undefined) row.isPreview = isPreview;
				const requiresPrevious = fieldBool(data, "requires_previous");
				if (requiresPrevious !== undefined) row.requiresPrevious = requiresPrevious;
				const dripOffsetDays = fieldNum(data, "drip_offset_days");
				if (dripOffsetDays !== undefined) row.dripOffsetDays = dripOffsetDays;

				await store.put(contentIndexId(courseId, "lesson", item.id), row);
				summary.lessonsUpserted += 1;
				summary.processed += 1;
			} catch (error) {
				summary.errors += 1;
				ctx.log.warn("backfill-content-index: lesson upsert threw", {
					lessonId: item.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
}

async function backfillTopics(
	ctx: PluginContext,
	summary: BackfillSummary,
): Promise<void> {
	if (!ctx.content) return;
	const store = contentIndexStore(ctx);
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await ctx.content.list(TOPICS_COLLECTION_SLUG, {
			where: { status: "published" },
			limit: PAGE_SIZE,
			cursor,
		});
		for (const item of page.items) {
			const data = item.data as Record<string, unknown>;
			const courseId = fieldStr(data, "course");
			if (!courseId) {
				summary.errors += 1;
				ctx.log.warn("backfill-content-index: topic missing course ref", {
					topicId: item.id,
				});
				continue;
			}
			try {
				const row: CourseContentIndexRow = {
					courseId,
					stepType: "topic",
					stepId: item.id,
					order: fieldNum(data, "order") ?? 0,
					status: "published",
				};
				const lessonId = fieldStr(data, "lesson");
				if (lessonId) row.lessonId = lessonId;
				if (item.publishedAt) row.publishedAt = item.publishedAt;
				const scheduledAt = (item as unknown as Record<string, unknown>)["scheduledAt"];
				if (typeof scheduledAt === "string") row.scheduledAt = scheduledAt;
				const dur = fieldNum(data, "duration_seconds");
				if (dur !== undefined) row.durationSeconds = dur;
				const requiresPrevious = fieldBool(data, "requires_previous");
				if (requiresPrevious !== undefined) row.requiresPrevious = requiresPrevious;

				await store.put(contentIndexId(courseId, "topic", item.id), row);
				summary.topicsUpserted += 1;
				summary.processed += 1;
			} catch (error) {
				summary.errors += 1;
				ctx.log.warn("backfill-content-index: topic upsert threw", {
					topicId: item.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
}

export async function backfillContentIndexReconciler(
	ctx: PluginContext,
): Promise<Result<BackfillSummary>> {
	const summary: BackfillSummary = {
		lessonsUpserted: 0,
		topicsUpserted: 0,
		errors: 0,
		processed: 0,
		skipped: 0,
	};
	await backfillLessons(ctx, summary);
	await backfillTopics(ctx, summary);
	ctx.log.info("backfill-content-index: complete", {
		lessonsUpserted: summary.lessonsUpserted,
		topicsUpserted: summary.topicsUpserted,
		errors: summary.errors,
	});
	return ok(summary);
}

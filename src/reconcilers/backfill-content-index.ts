import type { PluginContext, StorageCollection } from "emdash";

import { LESSONS_COLLECTION_SLUG } from "../constants.js";
import { contentIndexId } from "../modules/published-lessons.js";
import type { CourseContentIndexRow } from "../types/storage.js";

const MAX_REBUILD_SOURCE_PAGES = 100;

export interface BackfillSummary {
	lessonsUpserted: number;
	staleRowsDeleted: number;
	errors: number;
}

function indexStore(ctx: PluginContext): StorageCollection | null {
	return ctx.storage["course_content_index"] ?? null;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeIntegerField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Rebuild the shallow lesson projection from authoritative published content.
 * Per-item failures are isolated so one malformed lesson does not hide the
 * remaining course outline.
 */
export async function backfillContentIndex(ctx: PluginContext): Promise<BackfillSummary> {
	const summary: BackfillSummary = { lessonsUpserted: 0, staleRowsDeleted: 0, errors: 0 };
	if (!ctx.content) {
		summary.errors = 1;
		ctx.log.warn("Learn content index could not be rebuilt: content access is unavailable.");
		return summary;
	}
	const store = indexStore(ctx);
	if (!store) {
		summary.errors = 1;
		ctx.log.warn("Learn content index could not be rebuilt: projection storage is unavailable.");
		return summary;
	}

	const desired = new Map<string, CourseContentIndexRow>();
	let cursor: string | undefined;
	let sourcePagesRead = 0;
	/* oxlint-disable no-await-in-loop -- content pagination is sequential */
	do {
		sourcePagesRead += 1;
		let page;
		try {
			page = await ctx.content.list(LESSONS_COLLECTION_SLUG, {
				where: { status: "published" },
				limit: 100,
				cursor,
			});
		} catch (error) {
			summary.errors += 1;
			ctx.log.warn("Learn content index could not read the Lessons collection.", {
				error: error instanceof Error ? error.message : String(error),
			});
			return summary;
		}

		for (const lesson of page.items) {
			try {
				if (lesson.status !== "published") continue;
				const data = typeof lesson.data === "object" && lesson.data !== null ? lesson.data : {};
				const lessonId = stringField(lesson.id);
				const courseId = stringField(data["course"]);
				if (!courseId) {
					summary.errors += 1;
					ctx.log.warn("Learn content index skipped a lesson without a course reference.", {
						lessonId: lesson.id,
					});
					continue;
				}
				const title = stringField(data["title"]);
				const order = nonNegativeIntegerField(data["order"]);
				if (!lessonId || !title || order === undefined) {
					summary.errors += 1;
					ctx.log.warn("Learn content index skipped a malformed lesson.", {
						lessonId: lesson.id,
					});
					continue;
				}
				const row: CourseContentIndexRow = {
					courseId,
					stepType: "lesson",
					stepId: lessonId,
					order,
					status: "published",
				};
				desired.set(contentIndexId(courseId, lessonId), row);
			} catch (error) {
				summary.errors += 1;
				ctx.log.warn("Learn content index skipped a malformed lesson.", {
					lessonId: lesson.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (page.hasMore && !page.cursor) {
			summary.errors += 1;
			ctx.log.warn(
				"Learn content index rebuild stopped because Lesson pagination could not continue deterministically.",
			);
			return summary;
		}
		if (page.hasMore && sourcePagesRead >= MAX_REBUILD_SOURCE_PAGES) {
			summary.errors += 1;
			ctx.log.warn(
				`Learn content index rebuild stopped at the ${MAX_REBUILD_SOURCE_PAGES}-page source limit.`,
			);
			return summary;
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */

	const existing: Array<{ id: string; data: unknown }> = [];
	cursor = undefined;
	let projectionPagesRead = 0;
	/* oxlint-disable no-await-in-loop -- storage pagination is sequential */
	do {
		projectionPagesRead += 1;
		let page;
		try {
			page = await store.query({ limit: 100, cursor });
		} catch (error) {
			summary.errors += 1;
			ctx.log.warn("Learn content index could not read the existing projection.", {
				error: error instanceof Error ? error.message : String(error),
			});
			return summary;
		}
		existing.push(...page.items.map(({ id, data }) => ({ id, data })));
		if (page.hasMore && !page.cursor) {
			summary.errors += 1;
			ctx.log.warn(
				"Learn content index rebuild stopped because projection pagination could not continue deterministically.",
			);
			return summary;
		}
		if (page.hasMore && projectionPagesRead >= MAX_REBUILD_SOURCE_PAGES) {
			summary.errors += 1;
			ctx.log.warn(
				`Learn content index rebuild stopped at the ${MAX_REBUILD_SOURCE_PAGES}-page projection limit.`,
			);
			return summary;
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);

	const desiredEntries = [...desired.entries()];
	// oxlint-disable-next-line no-array-sort -- sorting a local copy for deterministic reconciliation
	desiredEntries.sort(([left], [right]) => left.localeCompare(right));

	// A Lesson reassignment changes the projection row id while the declared
	// `stepId` index remains unique. Remove only those stale conflicting rows
	// before upserting the new authoritative pointer.
	const desiredStepIds = new Set(desiredEntries.map(([, row]) => row.stepId));
	const orderedExisting = [...existing];
	// oxlint-disable-next-line no-array-sort -- sorting a local copy for deterministic reconciliation
	orderedExisting.sort((left, right) => left.id.localeCompare(right.id));
	const deletedBeforeUpsert = new Set<string>();
	for (const row of orderedExisting) {
		if (desired.has(row.id)) continue;
		const stepId =
			typeof row.data === "object" && row.data !== null
				? stringField(Reflect.get(row.data, "stepId"))
				: undefined;
		if (!stepId || !desiredStepIds.has(stepId)) continue;
		try {
			if (await store.delete(row.id)) {
				summary.staleRowsDeleted += 1;
				deletedBeforeUpsert.add(row.id);
			}
		} catch (error) {
			summary.errors += 1;
			ctx.log.warn("Learn content index could not delete a conflicting stale pointer.", {
				rowId: row.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	for (const [id, row] of desiredEntries) {
		try {
			await store.put(id, row);
			summary.lessonsUpserted += 1;
		} catch (error) {
			summary.errors += 1;
			ctx.log.warn("Learn content index could not upsert a lesson pointer.", {
				lessonId: row.stepId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Sorting above makes cleanup order stable for logs, fakes, and
	// partial-failure recovery.
	for (const row of orderedExisting) {
		if (desired.has(row.id) || deletedBeforeUpsert.has(row.id)) continue;
		try {
			if (await store.delete(row.id)) summary.staleRowsDeleted += 1;
		} catch (error) {
			summary.errors += 1;
			ctx.log.warn("Learn content index could not delete a stale pointer.", {
				rowId: row.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	/* oxlint-enable no-await-in-loop */

	ctx.log.info("Learn content index rebuilt.", summary);
	return summary;
}

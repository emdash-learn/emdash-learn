/**
 * drip-release-reminders reconciler (T14 / §21 Phase 5 / §8.4).
 *
 * Sweeps active enrollments, asks the curriculum engine for each user's
 * visible lessons, and emails the student ONCE per (lesson, user) when a
 * lesson has unlocked in the last hour. Dedupe is KV-backed via
 * `dripNotifiedKey` so re-running the reconciler is a no-op after the
 * initial send — matches the broader "crons are best-effort + idempotent"
 * invariant from §21.
 *
 * Bounded: at most `SAFETY_CAP` enrollments swept per tick. Per-enrollment
 * errors are logged + counted but never re-thrown (crons are best-effort).
 */

import type { PluginContext, StorageCollection } from "emdash";

import * as curriculum from "../engine/curriculum.js";
import { send } from "../engine/email-queue.js";
import { ok, type Result } from "../engine/result.js";
import { dripNotifiedKey } from "../kv-keys.js";
import type { Enrollment } from "../types/storage.js";

export interface ReconcilerSummary {
	processed: number;
	skipped: number;
	errors: number;
}

const PAGE_SIZE = 100;
const SAFETY_CAP = 500;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

function enrollmentsStore(ctx: PluginContext): StorageCollection<Enrollment> {
	const store = (ctx.storage as Record<string, StorageCollection | undefined>).enrollments;
	if (!store) throw new Error('Plugin storage collection "enrollments" is not declared.');
	return store as StorageCollection<Enrollment>;
}

async function processEnrollment(
	ctx: PluginContext,
	enrollment: Enrollment,
	now: Date,
	summary: ReconcilerSummary,
): Promise<void> {
	const lessons = await curriculum.forUser(ctx, enrollment.userId, enrollment.courseId);
	if (!lessons.ok) return;

	const windowStart = now.getTime() - WINDOW_MS;
	const windowEnd = now.getTime();

	for (const lesson of lessons.data) {
		if (!lesson.unlocked) continue;
		const unlockedMs = Date.parse(lesson.unlocksAt);
		if (Number.isNaN(unlockedMs)) continue;
		if (unlockedMs < windowStart || unlockedMs > windowEnd) continue;

		const key = dripNotifiedKey(lesson.id, enrollment.userId);
		// eslint-disable-next-line no-await-in-loop
		const notified = await ctx.kv.get(key);
		if (notified) {
			summary.skipped += 1;
			continue;
		}

		// eslint-disable-next-line no-await-in-loop
		const user = ctx.users?.get ? await ctx.users.get(enrollment.userId) : null;
		if (!user?.email) {
			summary.skipped += 1;
			continue;
		}

		// eslint-disable-next-line no-await-in-loop
		await send(ctx, {
			to: user.email,
			subject: `Lesson unlocked: ${lesson.title}`,
			text: `A new lesson "${lesson.title}" is now available in your course. Open it to continue learning.`,
		});
		// eslint-disable-next-line no-await-in-loop
		await ctx.kv.set(key, { notifiedAt: now.toISOString() });
		summary.processed += 1;
	}
}

export async function dripReleaseRemindersReconciler(
	ctx: PluginContext,
): Promise<Result<ReconcilerSummary>> {
	const summary: ReconcilerSummary = { processed: 0, skipped: 0, errors: 0 };
	const store = enrollmentsStore(ctx);
	const now = new Date();
	let swept = 0;
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await store.query({ limit: PAGE_SIZE, cursor });
		for (const row of page.items) {
			if (swept >= SAFETY_CAP) return ok(summary);
			swept += 1;
			if (row.data.revokedAt) continue;
			try {
				await processEnrollment(ctx, row.data, now, summary);
			} catch (error) {
				summary.errors += 1;
				ctx.log.warn("drip-release-reminders: enrollment sweep threw", {
					enrollmentId: row.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
	return ok(summary);
}

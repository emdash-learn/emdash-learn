/**
 * issue-certificates reconciler (T14 / §21 Phase 5).
 *
 * Two bounded sweeps, both idempotent:
 *
 *   (a) Backfill missing certs. For each completed, un-revoked enrollment
 *       lacking a certificate, call `certificates.issue` (which is itself
 *       idempotent per (userId, courseId)). Covers the case where a
 *       `course:completed` event-bus handler dropped its write — next cron
 *       tick picks it up.
 *
 *   (b) Auto-submit stuck quiz attempts. Any attempt whose `startedAt` is
 *       older than the safety window (72h) and was never submitted is
 *       finalized with the answers on file (empty array if none). Prevents
 *       the `quiz_attempts` table from accumulating orphaned rows after
 *       crashes / browser close.
 *
 * Both sweeps are capped at `SAFETY_CAP` processed items so a cron tick
 * can never run unbounded. Pages are fetched in batches of `PAGE_SIZE`.
 * Per-item failures increment `errors` and do NOT stop the sweep.
 */

import type { PluginContext, StorageCollection } from "emdash";

import * as certificates from "../engine/certificates.js";
import * as quizzes from "../engine/quizzes.js";
import { ok, type Result } from "../engine/result.js";
import type { Enrollment, QuizAttempt } from "../types/storage.js";

export interface ReconcilerSummary {
	processed: number;
	skipped: number;
	errors: number;
}

const PAGE_SIZE = 100;
const SAFETY_CAP = 500;
const STUCK_ATTEMPT_WINDOW_MS = 72 * 60 * 60 * 1000; // 72 hours

function collection<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	const store = (ctx.storage as Record<string, StorageCollection | undefined>)[name];
	if (!store) {
		throw new Error(`Plugin storage collection "${name}" is not declared.`);
	}
	return store as StorageCollection<T>;
}

async function sweepBackfillCertificates(
	ctx: PluginContext,
	summary: ReconcilerSummary,
): Promise<void> {
	const enrollments = collection<Enrollment>(ctx, "enrollments");
	const certs = collection(ctx, "certificates");
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await enrollments.query({ limit: PAGE_SIZE, cursor });
		for (const row of page.items) {
			if (summary.processed + summary.skipped + summary.errors >= SAFETY_CAP) {
				return;
			}
			const data = row.data;
			if (!data.completedAt || data.revokedAt) {
				continue;
			}
			try {
				const existing = await certs.query({
					where: { userId: data.userId, courseId: data.courseId },
					limit: 1,
				});
				if (existing.items.length > 0) {
					summary.skipped += 1;
					continue;
				}
				const result = await certificates.issue(ctx, data.userId, data.courseId);
				if (result.ok) {
					summary.processed += 1;
				} else {
					summary.errors += 1;
					ctx.log.warn("issue-certificates: issue failed", {
						userId: data.userId,
						courseId: data.courseId,
						code: result.error.code,
					});
				}
			} catch (error) {
				summary.errors += 1;
				ctx.log.warn("issue-certificates: backfill item threw", {
					enrollmentId: row.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
}

async function sweepStuckQuizAttempts(
	ctx: PluginContext,
	summary: ReconcilerSummary,
): Promise<void> {
	const attempts = collection<QuizAttempt>(ctx, "quiz_attempts");
	const cutoff = Date.now() - STUCK_ATTEMPT_WINDOW_MS;
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await attempts.query({ limit: PAGE_SIZE, cursor });
		for (const row of page.items) {
			if (summary.processed + summary.skipped + summary.errors >= SAFETY_CAP) {
				return;
			}
			const data = row.data;
			if (data.submittedAt) continue;
			const startedMs = Date.parse(data.startedAt);
			if (Number.isNaN(startedMs) || startedMs > cutoff) continue;
			try {
				const result = await quizzes.submitAttempt(ctx, row.id, data.answers ?? []);
				if (result.ok) {
					summary.processed += 1;
				} else {
					// Some failure codes (e.g. QUIZ_TIMEOUT from the hard-policy branch)
					// still persist the attempt row — that's a successful auto-close
					// from this reconciler's perspective. The engine has already
					// stamped submittedAt in that path.
					const refreshed = await attempts.get(row.id);
					if (refreshed?.submittedAt) {
						summary.processed += 1;
					} else {
						summary.errors += 1;
						ctx.log.warn("issue-certificates: auto-submit failed", {
							attemptId: row.id,
							code: result.error.code,
						});
					}
				}
			} catch (error) {
				summary.errors += 1;
				ctx.log.warn("issue-certificates: auto-submit threw", {
					attemptId: row.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
}

export async function issueCertificatesReconciler(
	ctx: PluginContext,
): Promise<Result<ReconcilerSummary>> {
	const summary: ReconcilerSummary = { processed: 0, skipped: 0, errors: 0 };
	await sweepBackfillCertificates(ctx, summary);
	if (summary.processed + summary.skipped + summary.errors < SAFETY_CAP) {
		await sweepStuckQuizAttempts(ctx, summary);
	}
	return ok(summary);
}

/**
 * send-lifecycle-emails reconciler (Track C — AUDIT C1, H4).
 *
 * Replaces the removed event-bus delivery path. Two idempotent sweeps:
 *
 *   (a) Welcome email. Scans enrollments for rows where:
 *       - `revokedAt` is unset (active enrollment)
 *       - `welcomeSentAt` is unset (not yet welcomed)
 *       For each match, resolves the user + course, sends a welcome email via
 *       `email-queue.send`, then stamps `welcomeSentAt` on the enrollment row.
 *
 *   (b) Completion email. Scans enrollments for rows where:
 *       - `completedAt` is set (course finished)
 *       - `completionSentAt` is unset (completion email not yet sent)
 *       Same shape: resolve user + course, send completion email, stamp
 *       `completionSentAt`. Note: certificate issuance is handled by the
 *       separate `issue-certificates` reconciler — we reference certs in
 *       the body copy but do NOT couple the logic here.
 *
 * Safety:
 *   - Capped at `SAFETY_CAP` items processed per cron tick so the reconciler
 *     can never run unbounded.
 *   - Per-item try/catch: a single bad row does not abort the sweep.
 *   - Both sweeps share the cap counter so the combined budget is bounded.
 *   - `welcomeSentAt` / `completionSentAt` stamps provide idempotency —
 *     a second reconciler run skips already-sent rows.
 *
 * Registered in `src/hooks/cron.ts` under the name "send-lifecycle-emails".
 */

import type { PluginContext, StorageCollection } from "emdash";

import { send } from "../engine/email-queue.js";
import { ok, type Result } from "../engine/result.js";
import type { Enrollment } from "../types/storage.js";

export interface ReconcilerSummary {
	processed: number;
	skipped: number;
	errors: number;
}

const PAGE_SIZE = 100;
const SAFETY_CAP = 500;

function enrollmentsStore(ctx: PluginContext): StorageCollection<Enrollment> {
	const store = (ctx.storage as Record<string, StorageCollection | undefined>).enrollments;
	if (!store) throw new Error('Plugin storage collection "enrollments" is not declared.');
	return store as StorageCollection<Enrollment>;
}

/**
 * Resolve user email for a given userId. Returns null when the user cannot be
 * resolved (ctx.users unavailable, user deleted, or no email on record).
 */
async function resolveUserEmail(ctx: PluginContext, userId: string): Promise<string | null> {
	if (!ctx.users?.get) return null;
	const user = await ctx.users.get(userId);
	return user?.email ?? null;
}

/**
 * Resolve course title for a given courseId. Returns a fallback string when
 * `ctx.content` is unavailable so emails still go out (operator can configure
 * content access if needed).
 */
async function resolveCourseTitle(ctx: PluginContext, courseId: string): Promise<string> {
	if (!ctx.content) return "your course";
	const item = await ctx.content.get("courses", courseId);
	const title = item?.data?.["title"];
	return typeof title === "string" && title.length > 0 ? title : "your course";
}

// ---------------------------------------------------------------------------
// Sweep (a): welcome emails
// ---------------------------------------------------------------------------

async function sweepWelcomeEmails(
	ctx: PluginContext,
	summary: ReconcilerSummary,
): Promise<void> {
	const store = enrollmentsStore(ctx);
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await store.query({ limit: PAGE_SIZE, cursor });
		for (const row of page.items) {
			if (summary.processed + summary.skipped + summary.errors >= SAFETY_CAP) return;

			const data = row.data;
			// Skip: revoked, or welcome already sent.
			if (data.revokedAt || data.welcomeSentAt) {
				summary.skipped += 1;
				continue;
			}

			try {
				const email = await resolveUserEmail(ctx, data.userId);
				if (!email) {
					summary.skipped += 1;
					continue;
				}
				const courseTitle = await resolveCourseTitle(ctx, data.courseId);

				await send(ctx, {
					to: email,
					subject: `Welcome to ${courseTitle}`,
					text: [
						`You are now enrolled in "${courseTitle}".`,
						"",
						"Log in to start learning at any time. Good luck!",
					].join("\n"),
				});

				// Stamp welcomeSentAt so re-runs skip this row.
				const updated: Enrollment = {
					...data,
					welcomeSentAt: new Date().toISOString(),
				};
				await store.put(row.id, updated);
				summary.processed += 1;
			} catch (error) {
				summary.errors += 1;
				ctx.log.warn("send-lifecycle-emails: welcome sweep item threw", {
					enrollmentId: row.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
}

// ---------------------------------------------------------------------------
// Sweep (b): completion emails
// ---------------------------------------------------------------------------

async function sweepCompletionEmails(
	ctx: PluginContext,
	summary: ReconcilerSummary,
): Promise<void> {
	const store = enrollmentsStore(ctx);
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await store.query({ limit: PAGE_SIZE, cursor });
		for (const row of page.items) {
			if (summary.processed + summary.skipped + summary.errors >= SAFETY_CAP) return;

			const data = row.data;
			// Skip: not completed yet, or completion email already sent.
			if (!data.completedAt || data.completionSentAt) {
				summary.skipped += 1;
				continue;
			}

			try {
				const email = await resolveUserEmail(ctx, data.userId);
				if (!email) {
					summary.skipped += 1;
					continue;
				}
				const courseTitle = await resolveCourseTitle(ctx, data.courseId);

				await send(ctx, {
					to: email,
					subject: `Congratulations — you completed "${courseTitle}"!`,
					text: [
						`You have successfully completed "${courseTitle}". Congratulations!`,
						"",
						"Your certificate of completion is being issued and will be",
						"available in your account shortly.",
					].join("\n"),
				});

				// Stamp completionSentAt so re-runs skip this row.
				const updated: Enrollment = {
					...data,
					completionSentAt: new Date().toISOString(),
				};
				await store.put(row.id, updated);
				summary.processed += 1;
			} catch (error) {
				summary.errors += 1;
				ctx.log.warn("send-lifecycle-emails: completion sweep item threw", {
					enrollmentId: row.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function sendLifecycleEmailsReconciler(
	ctx: PluginContext,
): Promise<Result<ReconcilerSummary>> {
	const summary: ReconcilerSummary = { processed: 0, skipped: 0, errors: 0 };
	await sweepWelcomeEmails(ctx, summary);
	if (summary.processed + summary.skipped + summary.errors < SAFETY_CAP) {
		await sweepCompletionEmails(ctx, summary);
	}
	return ok(summary);
}

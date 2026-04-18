/**
 * Cron dispatch hook (T14 / §21 Phase 5).
 *
 * Emdash's cron scheduler invokes one `cron` handler per tick with a
 * `{ name, data?, scheduledAt }` event. This module owns the routing
 * table: given `event.name`, it calls the matching reconciler in
 * `src/reconcilers/*.ts`. The reconcilers return a `Result<Summary>`
 * which we log; errors from a reconciler are logged via `ctx.log.error`
 * and NEVER thrown — crons are best-effort by design, and a throw here
 * would propagate back to the scheduler and interfere with sibling
 * tasks.
 *
 * The orchestrator wires this function into the plugin descriptor as
 * the `cron` hook after T14 merges; `sandbox-entry.ts` is deliberately
 * left untouched here per the task contract.
 */

import type { PluginContext } from "emdash";

import { dripReleaseRemindersReconciler } from "../reconcilers/drip-release-reminders.js";
import { flushEmailQueueReconciler } from "../reconcilers/flush-email-queue.js";
import {
	issueCertificatesReconciler,
	type ReconcilerSummary,
} from "../reconcilers/issue-certificates.js";
import type { Result } from "../engine/result.js";

export interface CronEvent {
	name: string;
	data?: Record<string, unknown>;
	scheduledAt: string;
}

type Reconciler = (ctx: PluginContext) => Promise<Result<ReconcilerSummary>>;

const ROUTES: Record<string, Reconciler> = {
	"issue-certificates": issueCertificatesReconciler,
	"drip-release-reminders": dripReleaseRemindersReconciler,
	"flush-email-queue": flushEmailQueueReconciler,
};

export async function cronDispatch(event: CronEvent, ctx: PluginContext): Promise<void> {
	const reconciler = ROUTES[event.name];
	if (!reconciler) {
		ctx.log.warn("unknown cron event", { name: event.name });
		return;
	}

	try {
		const result = await reconciler(ctx);
		if (result.ok) {
			ctx.log.info("cron reconciler finished", {
				name: event.name,
				processed: result.data.processed,
				skipped: result.data.skipped,
				errors: result.data.errors,
			});
		} else {
			ctx.log.error("cron reconciler returned error", {
				name: event.name,
				code: result.error.code,
				message: result.error.message,
			});
		}
	} catch (error) {
		ctx.log.error("cron reconciler threw", {
			name: event.name,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

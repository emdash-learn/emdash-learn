/**
 * flush-email-queue reconciler (T14 / §21 Phase 5 / §8.4).
 *
 * Thin wrapper around `email-queue.flush`. Maps `FlushSummary { sent,
 * remaining }` onto `ReconcilerSummary { processed, skipped, errors }` so
 * the cron hook can log all three reconcilers with the same shape.
 *
 * If `flush` itself throws (unexpected — it's designed to swallow
 * per-entry failures), we capture the error as `errors: 1` so the cron
 * hook still gets a readable summary and can surface it via `ctx.log`.
 */

import type { PluginContext } from "emdash";

import { flush } from "../engine/email-queue.js";
import { ok, type Result } from "../engine/result.js";

export interface ReconcilerSummary {
	processed: number;
	skipped: number;
	errors: number;
}

export async function flushEmailQueueReconciler(
	ctx: PluginContext,
): Promise<Result<ReconcilerSummary>> {
	try {
		const result = await flush(ctx);
		if (!result.ok) {
			ctx.log.warn("flush-email-queue: flush returned error", {
				code: result.error.code,
			});
			return ok({ processed: 0, skipped: 0, errors: 1 });
		}
		return ok({
			processed: result.data.sent,
			skipped: result.data.remaining,
			errors: 0,
		});
	} catch (error) {
		ctx.log.error("flush-email-queue: flush threw", {
			error: error instanceof Error ? error.message : String(error),
		});
		return ok({ processed: 0, skipped: 0, errors: 1 });
	}
}

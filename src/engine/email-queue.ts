/**
 * Email queue (§8.5 "No email provider" UX, §17.1, §14 "Email queue +
 * provider detection").
 *
 * `send()` is the write-facing API engine modules call. When `ctx.email` is
 * absent (no provider configured, or capability not granted), we persist the
 * message under `queue:email:${id}` and return `ok()` — upstream code treats
 * email as best-effort and must not fail the user's request. When `ctx.email`
 * exists we try an inline delivery; if the provider throws (transient outage)
 * we still queue the message so `flush-email-queue` cron (§8.4) can retry.
 *
 * `flush()` is the cron/reconciler counterpart. It scans `queue:email:*`, hands
 * each message to `ctx.email.send`, deletes the KV entry on success, and leaves
 * failures in place for the next sweep. Corrupt entries are deleted so they
 * don't block the queue forever.
 *
 * IDs are `${millis}-${uuid}` so `kv.list("queue:email:")` returns roughly
 * FIFO order (deterministic enough for the cron — strict ordering is not a
 * correctness property).
 */

import type { PluginContext } from "emdash";
import { randomUUID } from "node:crypto";

import { emailQueueKey } from "../kv-keys.js";
import type { Result } from "./result.js";
import { ok } from "./result.js";

export interface EmailMessage {
	to: string;
	subject: string;
	text: string;
	html?: string;
}

export interface FlushSummary {
	sent: number;
	remaining: number;
}

function isEmailMessage(value: unknown): value is EmailMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { to?: unknown }).to === "string" &&
		typeof (value as { subject?: unknown }).subject === "string" &&
		typeof (value as { text?: unknown }).text === "string"
	);
}

function newQueueId(): string {
	return `${Date.now().toString().padStart(14, "0")}-${randomUUID()}`;
}

async function enqueue(ctx: PluginContext, message: EmailMessage): Promise<void> {
	await ctx.kv.set(emailQueueKey(newQueueId()), message);
}

export async function send(
	ctx: PluginContext,
	message: EmailMessage,
): Promise<Result<void>> {
	if (!ctx.email) {
		await enqueue(ctx, message);
		return ok(undefined);
	}
	try {
		await ctx.email.send(message);
		return ok(undefined);
	} catch (error) {
		ctx.log.warn("inline email delivery failed; queueing for retry", {
			to: message.to,
			error: error instanceof Error ? error.message : String(error),
		});
		await enqueue(ctx, message);
		return ok(undefined);
	}
}

export async function flush(ctx: PluginContext): Promise<Result<FlushSummary>> {
	const entries = await ctx.kv.list("queue:email:");

	if (!ctx.email) {
		return ok({ sent: 0, remaining: entries.length });
	}

	let sent = 0;
	let remaining = 0;
	// Sequential by design: each provider.send may rate-limit or be stateful;
	// parallelizing could reorder deliveries and amplify transient outages.
	/* oxlint-disable no-await-in-loop */
	for (const { key, value } of entries) {
		if (!isEmailMessage(value)) {
			ctx.log.warn("dropping corrupt email-queue entry", { key });
			await ctx.kv.delete(key);
			continue;
		}
		try {
			await ctx.email.send(value);
			await ctx.kv.delete(key);
			sent += 1;
		} catch (error) {
			ctx.log.warn("queued email delivery failed; will retry next flush", {
				key,
				to: value.to,
				error: error instanceof Error ? error.message : String(error),
			});
			remaining += 1;
		}
	}
	/* oxlint-enable no-await-in-loop */

	return ok({ sent, remaining });
}

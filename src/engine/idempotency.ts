/**
 * Event-handler idempotency markers (§17.4, D23).
 *
 * Keys are `handled:${handlerId}:${eventKey}` (see `kv-keys.ts`) and every
 * marker carries `{ at: <ms epoch> }`. Emdash's KV has no native TTL, so we
 * implement the 30-day bound at read-time by filtering stale records — the
 * stale rows remain in KV until they're overwritten or explicitly deleted;
 * reconcilers can sweep them, but correctness only depends on the read filter.
 *
 * Tradeoff: stale rows accrue until cleanup. At our v1 scale (D42: 10k
 * enrollments, ~100k markers max over 30 days) the storage footprint is
 * negligible. Upstream `user:created` / TTL support would let us simplify.
 */

import type { PluginContext } from "emdash";

import { handledKey } from "../kv-keys.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface HandledMarker {
	at: number;
}

function isHandledMarker(value: unknown): value is HandledMarker {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { at?: unknown }).at === "number"
	);
}

export async function wasHandled(
	ctx: PluginContext,
	handlerId: string,
	eventKey: string,
): Promise<boolean> {
	const marker = await ctx.kv.get<unknown>(handledKey(handlerId, eventKey));
	if (!isHandledMarker(marker)) return false;
	return Date.now() - marker.at <= THIRTY_DAYS_MS;
}

export async function markHandled(
	ctx: PluginContext,
	handlerId: string,
	eventKey: string,
): Promise<void> {
	const marker: HandledMarker = { at: Date.now() };
	await ctx.kv.set(handledKey(handlerId, eventKey), marker);
}

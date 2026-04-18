/**
 * Engine event bus (§17.4, §8.1–§8.3).
 *
 * Handlers register at module-load time via top-level `on(...)` calls from
 * each engine module — there is no runtime registration surface, and the
 * handler map is a module-scoped singleton.
 *
 * Dispatch loop per handler:
 *   1. Check `handled:${handlerId}:${event.key}` marker — skip if present.
 *   2. Run the handler.
 *   3. On success, write the marker (30-day TTL handled by `idempotency.ts`).
 *   4. On throw: if `event.critical`, propagate; otherwise log + swallow so
 *      the reconciler sweeps (best-effort semantics per §8.2).
 *
 * Tests need a way to wipe the singleton between runs — `__resetHandlersForTests`
 * is exported for that purpose only. Production code never calls it.
 */

import type { PluginContext } from "emdash";

import type { EngineEvent, EngineEventName } from "../types/engine.js";
import { markHandled, wasHandled } from "./idempotency.js";

type Handler<E extends EngineEvent> = (event: E, ctx: PluginContext) => Promise<void>;

interface Registration {
	id: string;
	fn: Handler<EngineEvent>;
}

const handlers = new Map<EngineEventName, Registration[]>();

export function on<E extends EngineEvent>(
	name: E["name"],
	handlerId: string,
	fn: Handler<E>,
): void {
	const list = handlers.get(name) ?? [];
	list.push({ id: handlerId, fn: fn as Handler<EngineEvent> });
	handlers.set(name, list);
}

export async function emit(event: EngineEvent, ctx: PluginContext): Promise<void> {
	const list = handlers.get(event.name) ?? [];
	// Sequential by design: critical handlers must short-circuit later ones, and
	// idempotency markers must land in order so a re-emit replays the same set.
	/* oxlint-disable no-await-in-loop */
	for (const { id, fn } of list) {
		if (await wasHandled(ctx, id, event.key)) continue;
		try {
			await fn(event, ctx);
			await markHandled(ctx, id, event.key);
		} catch (error) {
			if (event.critical) throw error;
			ctx.log.error("event handler failed", {
				event: event.name,
				key: event.key,
				handlerId: id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	/* oxlint-enable no-await-in-loop */
}

/**
 * Test-only: clears the module-scoped handler registry. Tests that call
 * `on(...)` must reset between cases so registrations don't leak across tests.
 */
export function __resetHandlersForTests(): void {
	handlers.clear();
}

import type { PluginRoute } from "emdash";

import { ensureSetupComplete } from "../setup-gate.js";

/**
 * Apply the trusted setup precondition once at the runtime composition seam.
 *
 * Keeping this wrapper out of individual domain routes makes it difficult to
 * accidentally expose a newly registered route before its storage and content
 * schema have been verified.
 */
export function withSetupGate(routes: Record<string, PluginRoute>): Record<string, PluginRoute> {
	return Object.fromEntries(
		Object.entries(routes).map(([name, route]) => [
			name,
			{
				...route,
				async handler(ctx) {
					await ensureSetupComplete(ctx);
					return route.handler(ctx);
				},
			},
		]),
	);
}

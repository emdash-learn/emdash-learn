/**
 * Setup precheck helper (AUDIT C5).
 *
 * Every non-setup route handler calls `ensureSetupComplete(ctx)` as its first
 * gate after auth (even public:true routes, except setup:* themselves). If the
 * plugin has not been fully configured — i.e. `BootstrapState.version` is
 * below `BOOTSTRAP_VERSION` — a structured `PluginRouteError` is thrown with:
 *
 *   code:    LEARN_ERRORS.SETUP_INCOMPLETE
 *   status:  409
 *   details: { setupPath: "/_emdash/admin/plugins/lms-core/setup" }
 *
 * The `setupPath` detail lets API consumers (demo Astro pages, other plugins)
 * redirect or display a contextual "finish setup" prompt without hard-coding
 * the wizard URL.
 *
 * Why 409 Conflict? The server can't fulfil the request until a prerequisite
 * action (running the wizard) is completed. 409 is the best match in the HTTP
 * taxonomy for "state conflict blocking the operation."
 */

import { PluginRouteError, type PluginContext } from "emdash";

import { BOOTSTRAP_STATE_KEY } from "./kv-keys.js";
import { BOOTSTRAP_VERSION, LEARN_ERRORS } from "./constants.js";
import type { BootstrapState } from "./types/storage.js";

/** The URL fragment the wizard lives at, injected into error details. */
const SETUP_PATH = "/_emdash/admin/plugins/lms-core/setup";

/**
 * Read the bootstrap KV record without throwing. Returns version 0 when the
 * key is absent or malformed — both indicate "setup has not run."
 */
async function readBootstrapVersion(ctx: PluginContext): Promise<number> {
	try {
		const state = await ctx.kv.get<BootstrapState>(BOOTSTRAP_STATE_KEY);
		if (state && typeof state === "object" && typeof state.version === "number") {
			return state.version;
		}
	} catch {
		// Treat read failures as "not configured."
	}
	return 0;
}

/**
 * Throw a structured `PluginRouteError` when the plugin has not been fully
 * configured via the setup wizard.
 *
 * Call this as the **first statement** in every non-setup route handler, after
 * any auth gate. Example:
 *
 * ```ts
 * handler: async (ctx) => {
 *   await ensureSetupComplete(ctx);
 *   const user = requireRole(ctx as AuthContext, Role.SUBSCRIBER);
 *   // … rest of handler
 * }
 * ```
 *
 * The helper is a no-op (fast path) when version >= BOOTSTRAP_VERSION, so the
 * extra KV read adds one round-trip only in the misconfigured state.
 */
export async function ensureSetupComplete(ctx: PluginContext): Promise<void> {
	const version = await readBootstrapVersion(ctx);
	if (version >= BOOTSTRAP_VERSION) return;

	throw new PluginRouteError(
		LEARN_ERRORS.SETUP_INCOMPLETE,
		`Plugin setup is incomplete (bootstrap version ${version} < ${BOOTSTRAP_VERSION}). ` +
			`Open the setup wizard to finish configuration.`,
		409,
		{ setupPath: SETUP_PATH },
	);
}

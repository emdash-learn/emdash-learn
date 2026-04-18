import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import { PLUGIN_ID, PLUGIN_VERSION } from "./index.js";

/**
 * Native-format plugin entry.
 *
 * Emdash's native loader imports `createPlugin` as a named export from the
 * descriptor's `entrypoint` and calls it with the descriptor's `options`. The
 * function must return a resolved plugin (what `definePlugin()` produces).
 *
 * Wave 0 scope (T00): a no-op plugin — `plugin:install` logs a banner so we can
 * confirm the demo wires the plugin up correctly. Hooks, routes, cron, and
 * storage access all land in T01+ per `prd-plugin.md` §26.
 */
export function createPlugin() {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,

		admin: {
			entry: "@emdash/lms-core/admin",
			pages: [{ path: "/setup", label: "Setup", icon: "wrench" }],
		},

		hooks: {
			"plugin:install": async (_event: unknown, ctx: PluginContext) => {
				ctx.log.info("emdash-learn installed (scaffold)");
			},
		},
	});
}

export default createPlugin;

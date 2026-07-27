import type { PluginDescriptor } from "emdash";

import { PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";
import { LEARN_PLUGIN_CONTRACT } from "./plugin-contract.js";

export { PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

/**
 * Build-time descriptor consumed by EmDash's Astro integration.
 *
 * Keep this declaration shallow: the runtime entry owns routes, hooks, and
 * storage, while this entry only advertises package wiring and admin pages.
 */
export function lmsCorePlugin(): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		format: "native",
		entrypoint: "@emdash/lms-core/sandbox",
		adminEntry: "@emdash/lms-core/admin",
		componentsEntry: "@emdash/lms-core/astro",
		allowedHosts: [],
		capabilities: LEARN_PLUGIN_CONTRACT.capabilities,
		adminPages: LEARN_PLUGIN_CONTRACT.adminPages,
	};
}

export default lmsCorePlugin;

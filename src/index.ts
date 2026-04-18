/**
 * Emdash Learn plugin descriptor — runs in Vite at build time.
 *
 * Must stay side-effect-free. Runtime logic lives in `./sandbox-entry.ts`;
 * React admin UI in `./admin.tsx`; site-side block rendering in
 * `./astro/index.ts`.
 *
 * T01 scope: register the Setup admin page and wire admin + components
 * entries. The authoritative storage shape + composite indexes are declared
 * in `sandbox-entry.ts` (definePlugin) — the descriptor's `storage` only
 * supports flat `string[]` indexes (see emdash `StorageCollectionDeclaration`)
 * so composites are intentionally repeated there, not here.
 */

import type { PluginDescriptor } from "emdash";

import { PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

export { PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

export function lmsCorePlugin(): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		format: "native",
		entrypoint: "@emdash/lms-core/sandbox",
		adminEntry: "@emdash/lms-core/admin",
		componentsEntry: "@emdash/lms-core/astro",
		allowedHosts: [],
		adminPages: [{ path: "/setup", label: "Setup", icon: "wand" }],
	};
}

export default lmsCorePlugin;

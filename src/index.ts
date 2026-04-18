import type { PluginDescriptor } from "emdash";

export const PLUGIN_ID = "lms-core";
export const PLUGIN_VERSION = "0.0.0";

/**
 * Emdash Learn plugin descriptor.
 *
 * Runs in Vite at build time — must be side-effect free. Runtime logic lives in
 * `./sandbox-entry.ts`; React admin UI in `./admin.tsx`; site-side block
 * rendering in `./astro/index.ts`.
 *
 * Scope at Wave 0 (T00): registers a single "Setup" admin page so the sidebar
 * entry shows up. The wizard body and all other pages land in T01+.
 */
export function lmsCorePlugin(): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		format: "native",
		entrypoint: "@emdash/lms-core/sandbox",
		adminEntry: "@emdash/lms-core/admin",
		componentsEntry: "@emdash/lms-core/astro",
		adminPages: [
			{
				path: "/setup",
				label: "Setup",
				icon: "wrench",
			},
		],
		storage: {},
	};
}

export default lmsCorePlugin;

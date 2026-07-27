import { describe, expect, it } from "vitest";
import type { PluginContext } from "emdash";

import { BOOTSTRAP_VERSION } from "../../src/constants.js";
import { ensureSetupComplete } from "../../src/setup-gate.js";

function contextAt(
	version: number,
	verification?: {
		contractVersion: number;
		schema: "compatible";
		projection: "repaired";
	},
): PluginContext {
	// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- intentionally minimal PluginContext test double
	return {
		kv: {
			async get() {
				return { version, completedSteps: [], verification };
			},
		},
	} as unknown as PluginContext;
}

describe("setup gate", () => {
	it("returns a discoverable 409 before the content schema is ready", async () => {
		await expect(ensureSetupComplete(contextAt(0))).rejects.toMatchObject({
			name: "PluginRouteError",
			code: "LEARN_SETUP_INCOMPLETE",
			status: 409,
			details: {
				setupPath: "/_emdash/admin/plugins/lms-core/setup",
			},
		});
	});

	it("rejects a current-version marker without server-derived verification", async () => {
		await expect(ensureSetupComplete(contextAt(BOOTSTRAP_VERSION))).rejects.toMatchObject({
			code: "LEARN_SETUP_INCOMPLETE",
			status: 409,
		});
	});

	it("allows publishing routes after schema verification and projection repair", async () => {
		await expect(
			ensureSetupComplete(
				contextAt(BOOTSTRAP_VERSION, {
					contractVersion: BOOTSTRAP_VERSION,
					schema: "compatible",
					projection: "repaired",
				}),
			),
		).resolves.toBeUndefined();
	});
});

import { describe, expect, it, vi } from "vitest";

import { BOOTSTRAP_STATE_KEY } from "../../../src/kv-keys.js";
import { createSetupRoutes } from "../../../src/routes/setup.js";
import { SetupVerificationError } from "../../../src/setup/orchestrator.js";
import { createRouteContext } from "../../utils/route-context.js";

const verifiedState = {
	version: 4,
	completedSteps: ["collection:courses"],
	lastRunAt: "2026-07-26T10:00:00.000Z",
	verification: {
		contractVersion: 4,
		schema: "compatible" as const,
		projection: "repaired" as const,
	},
};

describe("setup routes", () => {
	it("returns only server-persisted bootstrap evidence", async () => {
		const routes = createSetupRoutes({ converge: vi.fn() });
		const ctx = createRouteContext({}, { kvValues: { [BOOTSTRAP_STATE_KEY]: verifiedState } });

		await expect(routes["setup:state"].handler(ctx)).resolves.toEqual({
			state: verifiedState,
			targetVersion: 4,
		});
	});

	it("runs server-side convergence without accepting client step claims", async () => {
		const result = {
			state: verifiedState,
			schemaWrites: 2,
			projection: {
				complete: true,
				lessonsUpserted: 3,
				staleRowsDeleted: 1,
				errors: 0,
				diagnostics: [],
			},
		};
		const converge = vi.fn(async () => result);
		const routes = createSetupRoutes({ converge });
		const ctx = createRouteContext({});

		await expect(routes["setup:run"].handler(ctx)).resolves.toEqual(result);
		expect(converge).toHaveBeenCalledWith(ctx);
		expect(routes["setup:run"].input?.safeParse({ completedSteps: ["fake"] }).success).toBe(false);
	});

	it("records and maps a verification conflict without trusting partial completion", async () => {
		const routes = createSetupRoutes({
			converge: async () => {
				throw new SetupVerificationError(
					"Course field type conflicts with the Learn contract.",
					"fields:courses",
					{ status: "conflict", summary: "Field type conflict." },
				);
			},
			now: () => new Date("2026-07-26T11:00:00.000Z"),
		});
		const ctx = createRouteContext({}, { kvValues: { [BOOTSTRAP_STATE_KEY]: verifiedState } });

		await expect(routes["setup:run"].handler(ctx)).rejects.toMatchObject({
			code: "LEARN_SETUP_CONFLICT",
			status: 409,
			details: {
				stepId: "fields:courses",
				probe: { status: "conflict" },
			},
		});
		await expect(ctx.kv.get(BOOTSTRAP_STATE_KEY)).resolves.toMatchObject({
			...verifiedState,
			lastRunAt: "2026-07-26T11:00:00.000Z",
			lastError: {
				stepId: "fields:courses",
				message: "Course field type conflicts with the Learn contract.",
				at: "2026-07-26T11:00:00.000Z",
			},
		});
	});
});

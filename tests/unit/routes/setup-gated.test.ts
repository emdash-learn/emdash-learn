import { describe, expect, it, vi } from "vitest";

import { BOOTSTRAP_STATE_KEY } from "../../../src/kv-keys.js";
import { withSetupGate } from "../../../src/routes/setup-gated.js";
import { createRouteContext } from "../../utils/route-context.js";

const verifiedSetup = {
	version: 4,
	completedSteps: [],
	verification: {
		contractVersion: 4,
		schema: "compatible" as const,
		projection: "repaired" as const,
	},
};

describe("withSetupGate", () => {
	it("preserves route metadata and invokes a handler only after verified setup", async () => {
		const handler = vi.fn(async () => ({ ok: true }));
		const input = { safeParse: vi.fn() };
		const routes = withSetupGate({
			example: {
				public: true,
				cacheControl: "public, max-age=60",
				input,
				handler,
			},
		});
		const ctx = createRouteContext({}, { kvValues: { [BOOTSTRAP_STATE_KEY]: verifiedSetup } });

		expect(routes.example?.public).toBe(true);
		expect(routes.example?.cacheControl).toBe("public, max-age=60");
		expect(routes.example?.input).toBe(input);
		await expect(routes.example?.handler(ctx)).resolves.toEqual({ ok: true });
		expect(handler).toHaveBeenCalledOnce();
	});

	it("rejects unverified setup before invoking the underlying handler", async () => {
		const handler = vi.fn(async () => ({ ok: true }));
		const routes = withSetupGate({ example: { handler } });
		const ctx = createRouteContext(
			{},
			{
				kvValues: {
					[BOOTSTRAP_STATE_KEY]: { version: 4, completedSteps: ["client-claimed"] },
				},
			},
		);

		await expect(routes.example?.handler(ctx)).rejects.toMatchObject({
			code: "LEARN_SETUP_INCOMPLETE",
			status: 409,
		});
		expect(handler).not.toHaveBeenCalled();
	});
});

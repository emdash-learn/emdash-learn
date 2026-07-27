import { PluginRouteError, type PluginContext, type PluginRoute, type RouteContext } from "emdash";
import { z } from "astro/zod";

import { BOOTSTRAP_VERSION } from "../constants.js";
import { BOOTSTRAP_STATE_KEY } from "../kv-keys.js";
import { SetupVerificationError, type SetupOrchestratorResult } from "../setup/orchestrator.js";
import type { BootstrapState } from "../types/storage.js";

const emptyInput = z.object({}).strict();

export interface SetupRouteServices {
	converge(ctx: RouteContext<Record<string, never>>): Promise<SetupOrchestratorResult>;
	now?: () => Date;
}

export async function readBootstrapState(ctx: PluginContext): Promise<BootstrapState> {
	const existing = await ctx.kv.get<BootstrapState>(BOOTSTRAP_STATE_KEY);
	if (
		existing &&
		typeof existing === "object" &&
		typeof existing.version === "number" &&
		Array.isArray(existing.completedSteps)
	) {
		return existing;
	}
	return { version: 0, completedSteps: [] };
}

async function rememberFailure(ctx: PluginContext, error: unknown, now: Date): Promise<void> {
	try {
		const current = await readBootstrapState(ctx);
		const stepId = error instanceof SetupVerificationError && error.stepId ? error.stepId : "setup";
		const message = error instanceof Error ? error.message : "Setup failed.";
		await ctx.kv.set(BOOTSTRAP_STATE_KEY, {
			...current,
			lastRunAt: now.toISOString(),
			lastError: {
				stepId,
				message,
				at: now.toISOString(),
			},
		} satisfies BootstrapState);
	} catch (persistError) {
		ctx.log.warn("Learn setup failed and its diagnostic state could not be persisted.", {
			error: persistError instanceof Error ? persistError.message : String(persistError),
		});
	}
}

export function createSetupRoutes(services: SetupRouteServices) {
	const state: PluginRoute = {
		permission: "plugins:manage",
		handler: async (ctx) => ({
			state: await readBootstrapState(ctx),
			targetVersion: BOOTSTRAP_VERSION,
		}),
	};

	const run: PluginRoute<Record<string, never>> = {
		input: emptyInput,
		permission: "plugins:manage",
		handler: async (ctx) => {
			if (ctx.request.method.toUpperCase() !== "POST") {
				throw new PluginRouteError(
					"LEARN_METHOD_NOT_ALLOWED",
					"Setup convergence requires POST.",
					405,
				);
			}
			try {
				return await services.converge(ctx);
			} catch (error) {
				const now = (services.now ?? (() => new Date()))();
				await rememberFailure(ctx, error, now);
				if (error instanceof SetupVerificationError) {
					throw new PluginRouteError("LEARN_SETUP_CONFLICT", error.message, 409, {
						stepId: error.stepId,
						probe: error.probe,
					});
				}
				throw error;
			}
		},
	};

	return {
		"setup:state": state,
		"setup:run": run,
	} as const;
}

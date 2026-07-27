import { z } from "astro/zod";
import { PluginRouteError, type PluginContext, type PluginRoute } from "emdash";

import { requireVerifiedLearner } from "../modules/learner-principal.js";
import { PrivacyErasureError, type PrivacyErasure } from "../modules/privacy-erasure.js";
import { learnerPrincipalFromRoute } from "./route-principal.js";

export const privacyEraseMyDataInput = z.object({}).strict();

type PrivacyEraseMyDataInput = z.infer<typeof privacyEraseMyDataInput>;

export interface PrivacyErasureRouteServices {
	createPrivacyErasure(ctx: PluginContext): PrivacyErasure | Promise<PrivacyErasure>;
}

function requirePost(request: Request): void {
	if (request.method.toUpperCase() !== "POST") {
		throw new PluginRouteError(
			"LEARN_METHOD_NOT_ALLOWED",
			"Privacy Erasure routes require POST.",
			405,
		);
	}
}

function toRouteError(error: unknown): never {
	if (error instanceof PluginRouteError) throw error;
	if (error instanceof PrivacyErasureError) {
		throw new PluginRouteError(error.code, error.message, error.status, {
			failedCategories: error.failedCategories,
			deleted: error.deleted,
		});
	}
	if (
		typeof error === "object" &&
		error !== null &&
		Reflect.get(error, "code") === "LEARN_UNAUTHENTICATED"
	) {
		throw new PluginRouteError(
			"LEARN_UNAUTHENTICATED",
			"A verified EmDash learner session is required.",
			401,
		);
	}
	throw error;
}

export function createPrivacyErasureRoutes(services: PrivacyErasureRouteServices) {
	const eraseMyData: PluginRoute<PrivacyEraseMyDataInput> & {
		permission: "content:read";
	} = {
		input: privacyEraseMyDataInput,
		permission: "content:read",
		handler: async (ctx) => {
			try {
				requirePost(ctx.request);
				const learner = requireVerifiedLearner(learnerPrincipalFromRoute(ctx));
				const privacy = await services.createPrivacyErasure(ctx);
				return await privacy.eraseMyData(learner);
			} catch (error) {
				return toRouteError(error);
			}
		},
	};

	return {
		"privacy:erase-my-data": eraseMyData,
	} as const;
}

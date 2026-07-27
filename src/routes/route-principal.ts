import type { RouteContext } from "emdash";

import { principalFromCore, type LearnerPrincipal } from "../modules/learner-principal.js";

/**
 * The only transport adapter allowed to read EmDash's route principal.
 *
 * This uses a structural read until Learn can raise its peer dependency to the
 * first published EmDash version that declares `RouteContext.principal`.
 */
export function learnerPrincipalFromRoute(ctx: RouteContext): LearnerPrincipal {
	const value = Reflect.get(ctx, "principal");
	if (typeof value !== "object" || value === null) return principalFromCore(null);
	const id = Reflect.get(value, "id");
	return principalFromCore(typeof id === "string" && id.length > 0 ? { id } : null);
}

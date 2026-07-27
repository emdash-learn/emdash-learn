/**
 * Minimal, non-PII identity supplied by EmDash after authentication.
 *
 * This mirrors the pending core RouteContext principal contract without
 * coupling learning modules to transport or to the global user profile.
 */
export interface CoreRoutePrincipal {
	id: string;
}

export interface AnonymousLearner {
	kind: "anonymous";
}

export interface VerifiedLearner {
	kind: "verified";
	learnerId: string;
}

export type LearnerPrincipal = AnonymousLearner | VerifiedLearner;

export class LearnerPrincipalError extends Error {
	readonly code = "LEARN_UNAUTHENTICATED";
	readonly status = 401;

	constructor() {
		super("A verified EmDash learner session is required.");
		this.name = "LearnerPrincipalError";
	}
}

export function principalFromCore(
	principal: CoreRoutePrincipal | null | undefined,
): LearnerPrincipal {
	if (!principal) return { kind: "anonymous" };
	return {
		kind: "verified",
		learnerId: principal.id,
	};
}

export function requireVerifiedLearner(principal: LearnerPrincipal): VerifiedLearner {
	if (principal.kind === "verified") return principal;
	throw new LearnerPrincipalError();
}

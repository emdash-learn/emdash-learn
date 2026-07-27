import type { VerifiedLearner } from "./learner-principal.js";

/**
 * One attributable data category that can erase records for a trusted
 * Verified Learner. Implementations must be idempotent and return the number
 * of records deleted by this invocation.
 */
export interface LearnerDataErasurePort {
	erase(learner: VerifiedLearner): Promise<number>;
}

export interface PrivacyErasureDependencies {
	lessonCompletions: LearnerDataErasurePort;
	assessmentAttempts: LearnerDataErasurePort;
	rawEngagementObservations: LearnerDataErasurePort;
}

export interface PrivacyErasureResult {
	deleted: {
		lessonCompletions: number;
		assessmentAttempts: number;
		rawEngagementObservations: number;
	};
}

export interface PrivacyErasure {
	eraseMyData(learner: VerifiedLearner): Promise<PrivacyErasureResult>;
}

export type PrivacyErasureCategory = keyof PrivacyErasureResult["deleted"];

export class PrivacyErasureError extends Error {
	readonly code = "LEARN_PRIVACY_ERASURE_FAILED";
	readonly status = 500;

	constructor(
		readonly failedCategories: PrivacyErasureCategory[],
		readonly deleted: PrivacyErasureResult["deleted"],
	) {
		super("Some learner data could not be erased. The request can be retried safely.");
		this.name = "PrivacyErasureError";
	}
}

export function createPrivacyErasure(dependencies: PrivacyErasureDependencies): PrivacyErasure {
	return {
		async eraseMyData(learner) {
			const [lessonResult, attemptResult, observationResult] = await Promise.allSettled([
				dependencies.lessonCompletions.erase(learner),
				dependencies.assessmentAttempts.erase(learner),
				dependencies.rawEngagementObservations.erase(learner),
			]);
			const deleted: PrivacyErasureResult["deleted"] = {
				lessonCompletions: lessonResult.status === "fulfilled" ? lessonResult.value : 0,
				assessmentAttempts: attemptResult.status === "fulfilled" ? attemptResult.value : 0,
				rawEngagementObservations:
					observationResult.status === "fulfilled" ? observationResult.value : 0,
			};
			const failedCategories: PrivacyErasureCategory[] = [];
			if (lessonResult.status === "rejected") failedCategories.push("lessonCompletions");
			if (attemptResult.status === "rejected") failedCategories.push("assessmentAttempts");
			if (observationResult.status === "rejected") {
				failedCategories.push("rawEngagementObservations");
			}
			if (failedCategories.length > 0) {
				throw new PrivacyErasureError(failedCategories, deleted);
			}
			return { deleted };
		},
	};
}

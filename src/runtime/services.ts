import {
	PluginRouteError,
	type PluginContext,
	type RouteContext,
	type StorageCollection,
} from "emdash";

import {
	createAssessmentStorageAdapter,
	type AssessmentHeadRecord,
} from "../adapters/assessment-storage.js";
import { createCompletionFactStoreAdapter } from "../adapters/completion-fact-store.js";
import { createEngagementStoreAdapter } from "../adapters/engagement-store.js";
import { createRawEngagementErasureAdapter } from "../adapters/raw-engagement-erasure.js";
import {
	createAssessment,
	type Assessment,
	type AssessmentAttemptRecord,
	type AssessmentRevisionRecord,
	type DraftCheck,
} from "../modules/assessment/index.js";
import {
	createEngagementReporting,
	type EngagementReporting,
	type StoredEngagementObservation,
} from "../modules/engagement-reporting/index.js";
import {
	createLearningRecord,
	type CompletionFact,
	type LearningRecord,
} from "../modules/learning-record/index.js";
import {
	createPrivacyErasure as createPrivacyErasureDomain,
	type PrivacyErasure,
} from "../modules/privacy-erasure.js";
import { getPublishedCourse, getPublishedLesson } from "../modules/published-courses.js";
import { requireInstallationDigest } from "../security/installation-digest.js";
import { createPublicRateLimiter, type PublicRateLimiter } from "../security/public-rate-limit.js";

export interface LearnRuntimeDependencies {
	now: () => Date;
	nextUuid: () => string;
}

export interface LearnRuntimeServices {
	createAssessment(ctx: PluginContext): Promise<Assessment>;
	createLearningRecord(ctx: PluginContext): Promise<LearningRecord>;
	createReporting(ctx: PluginContext): Promise<EngagementReporting>;
	createPrivacyErasure(ctx: PluginContext): Promise<PrivacyErasure>;
	beforePublicAssessment(ctx: RouteContext): Promise<void>;
	requirePublishedAssessmentCourse(ctx: RouteContext, courseId: string): Promise<void>;
	beforePublicObservation(ctx: RouteContext): Promise<void>;
}

function requireCollection<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	const collection = ctx.storage[name];
	if (!collection) {
		throw new PluginRouteError(
			"LEARN_SETUP_INCOMPLETE",
			`Learn storage collection "${name}" is unavailable. Run plugin setup.`,
			409,
		);
	}
	// Storage is type-erased by EmDash and recovered at this composition boundary;
	// each domain adapter validates/owns the records in its declared collection.
	// oxlint-disable-next-line typescript-eslint(no-unsafe-type-assertion)
	return collection as StorageCollection<T>;
}

function opaqueId(
	kind: "check" | "revision" | "attempt" | "observation" | "completion",
	uuid: string,
): string {
	return `${kind}_${uuid.replaceAll("-", "")}`;
}

async function requirePublishedCourse(ctx: PluginContext, courseId: string): Promise<void> {
	if (await getPublishedCourse(ctx, { courseId })) return;
	throw new PluginRouteError(
		"LEARN_CONTENT_NOT_FOUND",
		"Published learning content was not found.",
		404,
	);
}

function inputRecord(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null
		? Object.fromEntries(Object.entries(input))
		: {};
}

export function createLearnRuntimeServices(
	dependencies: LearnRuntimeDependencies = {
		now: () => new Date(),
		nextUuid: () => crypto.randomUUID(),
	},
): LearnRuntimeServices {
	const publicLimiters = new Map<string, PublicRateLimiter>();

	async function limiter(ctx: PluginContext): Promise<PublicRateLimiter> {
		const digest = await requireInstallationDigest(ctx.kv);
		const installationKey = await digest("public-rate-limit-installation", "v1");
		const existing = publicLimiters.get(installationKey);
		if (existing) return existing;
		const created = createPublicRateLimiter({
			now: () => dependencies.now().valueOf(),
			digest,
		});
		publicLimiters.set(installationKey, created);
		return created;
	}

	async function applyPublicLimit(ctx: RouteContext): Promise<void> {
		const rateLimiter = await limiter(ctx);
		await rateLimiter.check({
			ip: ctx.requestMeta.ip,
		});
	}

	async function createAssessmentService(ctx: PluginContext): Promise<Assessment> {
		const digest = await requireInstallationDigest(ctx.kv);
		return createAssessment({
			storage: createAssessmentStorageAdapter({
				drafts: requireCollection<DraftCheck>(ctx, "assessment_drafts"),
				revisions: requireCollection<AssessmentRevisionRecord>(ctx, "assessment_revisions"),
				heads: requireCollection<AssessmentHeadRecord>(ctx, "assessment_heads"),
				attempts: requireCollection<AssessmentAttemptRecord>(ctx, "assessment_attempts"),
			}),
			clock: {
				now: () => dependencies.now().toISOString(),
			},
			ids: {
				next: (kind) => opaqueId(kind, dependencies.nextUuid()),
			},
			hash: {
				digest: (value) => digest("assessment-record", value),
			},
		});
	}

	async function createReportingService(ctx: PluginContext): Promise<EngagementReporting> {
		const digest = await requireInstallationDigest(ctx.kv);
		return createEngagementReporting({
			store: createEngagementStoreAdapter(
				requireCollection<StoredEngagementObservation>(ctx, "engagement_observations"),
			),
			clock: dependencies.now,
			nextId: () => opaqueId("observation", dependencies.nextUuid()),
			pseudonymize: (learnerId, day) =>
				digest("engagement-actor", JSON.stringify([day, learnerId])),
		});
	}

	async function createLearningRecordService(ctx: PluginContext): Promise<LearningRecord> {
		const digest = await requireInstallationDigest(ctx.kv);
		return createLearningRecord({
			completions: createCompletionFactStoreAdapter(
				requireCollection<CompletionFact>(ctx, "lesson_completions"),
				{
					nextId: () => opaqueId("completion", dependencies.nextUuid()),
				},
			),
			content: {
				async getPublishedLesson(lessonId) {
					const lesson = await getPublishedLesson(ctx, lessonId);
					return lesson ? { lessonId: lesson.id, courseId: lesson.courseId } : null;
				},
				async listPublishedLessons(courseId) {
					const detail = await getPublishedCourse(ctx, { courseId });
					return detail
						? {
								courseId,
								lessonIds: detail.lessons.map((lesson) => lesson.id),
							}
						: null;
				},
			},
			clock: dependencies.now,
			hash: {
				digest: (value) => digest("learning-owner", value),
			},
		});
	}

	return {
		createAssessment: createAssessmentService,
		createLearningRecord: createLearningRecordService,
		createReporting: createReportingService,
		async createPrivacyErasure(ctx) {
			const [assessment, digest] = await Promise.all([
				createAssessmentService(ctx),
				requireInstallationDigest(ctx.kv),
			]);
			const learning = await createLearningRecordService(ctx);
			const observations = requireCollection<StoredEngagementObservation>(
				ctx,
				"engagement_observations",
			);
			const engagementStore = createEngagementStoreAdapter(observations);
			return createPrivacyErasureDomain({
				lessonCompletions: {
					async erase(learner) {
						const result = await learning.eraseLearner(learner);
						return result.deletedCompletions;
					},
				},
				assessmentAttempts: {
					erase: (learner) => assessment.eraseLearnerAttempts(learner),
				},
				rawEngagementObservations: createRawEngagementErasureAdapter({
					observations,
					pseudonymize: (learnerId, day) =>
						digest("engagement-actor", JSON.stringify([day, learnerId])),
					clock: dependencies.now,
					pruneExpiredBefore: (cutoff) => engagementStore.deleteObservationsBefore(cutoff),
				}),
			});
		},
		async beforePublicAssessment(ctx) {
			await applyPublicLimit(ctx);
		},
		async requirePublishedAssessmentCourse(ctx, courseId) {
			await requirePublishedCourse(ctx, courseId);
		},
		async beforePublicObservation(ctx) {
			await applyPublicLimit(ctx);
			const input = inputRecord(ctx.input);
			const courseId = input["courseId"];
			if (typeof courseId !== "string") {
				throw new PluginRouteError(
					"LEARN_CONTENT_NOT_FOUND",
					"Published learning content was not found.",
					404,
				);
			}
			await requirePublishedCourse(ctx, courseId);
			if (input["type"] === "lesson_opened") {
				const lessonId = input["lessonId"];
				const lesson =
					typeof lessonId === "string" ? await getPublishedLesson(ctx, lessonId) : null;
				if (!lesson || lesson.courseId !== courseId) {
					throw new PluginRouteError(
						"LEARN_CONTENT_NOT_FOUND",
						"Published learning content was not found.",
						404,
					);
				}
			}
			if (input["type"] === "check_opened") {
				const checkId = input["checkId"];
				const assessment = typeof checkId === "string" ? await createAssessmentService(ctx) : null;
				if (
					typeof checkId !== "string" ||
					!assessment ||
					!(await assessment.present({ courseId, checkId }))
				) {
					throw new PluginRouteError(
						"LEARN_ASSESSMENT_NOT_FOUND",
						"Published Knowledge Check not found.",
						404,
					);
				}
			}
		},
	};
}

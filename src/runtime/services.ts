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
import { createEngagementStoreAdapter } from "../adapters/engagement-store.js";
import {
	createAssessment,
	type Assessment,
	type AssessmentRevisionRecord,
	type DraftCheck,
} from "../modules/assessment/index.js";
import {
	createEngagementReporting,
	type EngagementReporting,
	type StoredEngagementObservation,
} from "../modules/engagement-reporting/index.js";
import { getPublishedCourse, getPublishedLesson } from "../modules/published-courses.js";
import { requireInstallationDigest } from "../security/installation-digest.js";
import { createPublicRateLimiter, type PublicRateLimiter } from "../security/public-rate-limit.js";

export interface LearnRuntimeDependencies {
	now: () => Date;
	nextUuid: () => string;
}

export interface LearnRuntimeServices {
	createAssessment(ctx: PluginContext): Promise<Assessment>;
	createReporting(ctx: PluginContext): Promise<EngagementReporting>;
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

function opaqueId(kind: "check" | "revision" | "attempt" | "observation", uuid: string): string {
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
		return createEngagementReporting({
			store: createEngagementStoreAdapter(
				requireCollection<StoredEngagementObservation>(ctx, "engagement_observations"),
			),
			clock: dependencies.now,
			nextId: () => opaqueId("observation", dependencies.nextUuid()),
		});
	}

	return {
		createAssessment: createAssessmentService,
		createReporting: createReportingService,
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

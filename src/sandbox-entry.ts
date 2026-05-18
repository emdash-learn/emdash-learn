/**
 * Native-format plugin entry. Emdash imports `createPlugin` from this module
 * and calls it with the descriptor's `options`. The return is what ends up in
 * `ctx.plugins[…]` and drives hook/route dispatch.
 *
 * T01 scope:
 *   - Seed KV defaults + bootstrap state on install (§17.3).
 *   - Honor `deleteData` on uninstall by deleting the authored courses +
 *     lessons collections (D4, §4.5). Plugin storage collections are dropped
 *     by emdash core when `deleteData=true`.
 *   - Expose two route pairs the SetupWizardPage calls over RPC:
 *       - `setup:state`  — read the bootstrap KV record.
 *       - `setup:mark`   — persist wizard-declared progress.
 *     All schema mutations themselves still happen from the admin browser
 *     session against `/_emdash/api/schema/*` (D2), not via plugin routes.
 */

import { elements } from "@emdash-cms/blocks";
import { definePlugin, PluginRouteError } from "emdash";
import type { PluginContext, PluginRoute } from "emdash";
import { z } from "astro/zod";

import {
	BOOTSTRAP_VERSION,
	COURSES_COLLECTION_SLUG,
	DEFAULT_SETTINGS,
	LEARN_ERRORS,
	LESSONS_COLLECTION_SLUG,
	PLUGIN_ID,
	PLUGIN_VERSION,
	TOPICS_COLLECTION_SLUG,
} from "./constants.js";
import { commentBeforeCreate } from "./hooks/comment.js";
import {
	contentAfterDelete,
	contentAfterPublish,
	contentAfterUnpublish,
	contentBeforeDelete,
} from "./hooks/content.js";
import { cronDispatch } from "./hooks/cron.js";
import { backfillContentIndexReconciler } from "./reconcilers/backfill-content-index.js";
import { BOOTSTRAP_STATE_KEY, settingKey } from "./kv-keys.js";
import { Role } from "./authz.js";
import { adminAnalyticsRoutes } from "./routes/admin-analytics.js";
import { adminSettingsRoutes } from "./routes/admin-settings.js";
import { instructorAnalyticsRoutes } from "./routes/instructor-analytics.js";
import { cohortRoutes } from "./routes/instructor-cohorts.js";
import { instructorAssignmentRoutes } from "./routes/instructor-assignments.js";
import { instructorLessonRoutes } from "./routes/instructor-lessons.js";
import { instructorTopicRoutes } from "./routes/instructor-topics.js";
import { catalogRoutes } from "./routes/public-catalog.js";
import { certificateRoutesPublic } from "./routes/public-certificates.js";
import { quizRoutes } from "./routes/quizzes.js";
import { certificateRoutesStudent } from "./routes/student-certificates.js";
import { curriculumRoutes } from "./routes/student-curriculum.js";
import { enrollmentRoutes } from "./routes/student-enrollments.js";
import { progressRoutes } from "./routes/student-progress.js";
import type { BootstrapState } from "./types/storage.js";

const setupMarkInput = z.object({
	completedSteps: z.array(z.string()).max(64),
	lastError: z
		.object({
			stepId: z.string(),
			message: z.string().max(2000),
			at: z.string(),
		})
		.optional(),
});

type SetupMarkInput = z.infer<typeof setupMarkInput>;

async function seedDefaultSettings(ctx: PluginContext): Promise<void> {
	await Promise.all(
		Object.entries(DEFAULT_SETTINGS).map(async ([key, value]) => {
			const fullKey = settingKey(key);
			const existing = await ctx.kv.get(fullKey);
			if (existing === null) await ctx.kv.set(fullKey, value);
		}),
	);
}

async function readBootstrap(ctx: PluginContext): Promise<BootstrapState> {
	const existing = await ctx.kv.get<BootstrapState>(BOOTSTRAP_STATE_KEY);
	if (existing && typeof existing === "object" && Array.isArray(existing.completedSteps)) {
		return existing;
	}
	return { version: 0, completedSteps: [] };
}

export function createPlugin() {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,

		// Must mirror the descriptor's capabilities (src/index.ts). Engine
		// reads course/lesson content, resolves users for certs + cohorts, and
		// optionally ships welcome/completion emails via ctx.email.
		capabilities: ["read:content", "read:users", "email:send"],

		storage: {
			enrollments: {
				indexes: ["userId", "courseId", "enrolledAt"],
				uniqueIndexes: [["userId", "courseId"]],
			},
			step_progress: {
				indexes: [
					"userId",
					"courseId",
					"stepId",
					"stepType",
					["userId", "courseId"],
					["userId", "courseId", "stepType"],
					"completedAt",
				],
				uniqueIndexes: [["userId", "stepType", "stepId"]],
			},
			quizzes: {
				indexes: ["updatedAt"],
			},
			quiz_attempts: {
				indexes: ["userId", "quizId", ["userId", "quizId"], "submittedAt"],
			},
			certificates: {
				indexes: ["userId", "courseId", "issuedAt"],
				uniqueIndexes: [["userId", "courseId"], "verificationCode"],
			},
			cert_verify_attempts: {
				indexes: [["ip", "bucket"], "ts"],
			},
			cohorts: {
				indexes: ["slug"],
				uniqueIndexes: ["slug"],
			},
			cohort_members: {
				indexes: ["cohortId", "userId"],
				uniqueIndexes: [["cohortId", "userId"]],
			},
			course_instructors: {
				indexes: ["courseId", "userId"],
				uniqueIndexes: [["courseId", "userId"]],
			},
			course_content_index: {
				indexes: [
					"courseId",
					"lessonId",
					["courseId", "stepType"],
					["courseId", "stepType", "order"],
				],
				uniqueIndexes: [["courseId", "stepType", "stepId"]],
			},
		},

		admin: {
			entry: "@emdash/lms-core/admin",
			pages: [
				{ path: "/setup", label: "Setup", icon: "wand" },
				{ path: "/quizzes", label: "Quizzes", icon: "list-checks" },
			],
			portableTextBlocks: [
				{
					type: "lmsQuiz",
					label: "Quiz",
					icon: "list-checks",
					description: "Insert a quiz the student must pass to complete the lesson",
					fields: [elements.textInput("quizId", "Quiz ID", { placeholder: "quiz_…" })],
				},
			],
		},

		hooks: {
			"plugin:install": async (_event, ctx) => {
				await seedDefaultSettings(ctx);
				const current = await readBootstrap(ctx);
				if (current.version === 0) {
					const seeded: BootstrapState = { version: 0, completedSteps: [] };
					await ctx.kv.set(BOOTSTRAP_STATE_KEY, seeded);
				}
				ctx.log.info(`${PLUGIN_ID} installed; awaiting setup wizard run.`);
			},

			"plugin:uninstall": async (event, ctx) => {
				if (!event.deleteData) {
					ctx.log.info(`${PLUGIN_ID} uninstalled (data preserved).`);
					return;
				}

				// emdash core drops plugin storage (enrollments, progress, etc.)
				// automatically when deleteData=true.
				//
				// Content collections (courses, lessons, topics) require the
				// `schema:manage` permission which is only available via the admin
				// browser session — this hook runs server-side without cookies,
				// so we CANNOT drop them here (AUDIT C4/H8).
				//
				// Instead, we verify whether any content data exists. If it does,
				// we throw so the admin knows they must use the wizard's
				// "Drop plugin data" action BEFORE uninstalling. If collections
				// are empty or absent, uninstall can proceed cleanly.
				if (ctx.content) {
					const hasData = await Promise.all(
						[TOPICS_COLLECTION_SLUG, LESSONS_COLLECTION_SLUG, COURSES_COLLECTION_SLUG].map(
							async (slug) => {
								try {
									const page = await ctx.content!.list(slug, { limit: 1 });
									return page.items.length > 0;
								} catch {
									// Collection doesn't exist or isn't accessible — treat as empty.
									return false;
								}
							},
						),
					);

					if (hasData.some(Boolean)) {
						throw new Error(
							`${PLUGIN_ID}: uninstall with deleteData=true was requested, but the ` +
								`courses, lessons, and/or topics content collections still contain data. ` +
								`Open the setup wizard at /_emdash/admin/plugins/lms-core/setup and use ` +
								`the "Drop plugin data" action to delete authored content before uninstalling. ` +
								`Plugin storage (enrollments, progress, certificates, etc.) will be ` +
								`dropped by emdash automatically when you proceed.`,
						);
					}
				}

				ctx.log.info(`${PLUGIN_ID} uninstalled with deleteData=true (content collections empty).`);
			},

			// Wave 4 hooks — per-file ownership per §17.1.
			"content:beforeDelete": contentBeforeDelete,
			"content:afterPublish": contentAfterPublish,
			"content:afterUnpublish": contentAfterUnpublish,
			"content:afterDelete": contentAfterDelete,
			"comment:beforeCreate": commentBeforeCreate,
			cron: cronDispatch,
		},

		routes: {
			"setup:state": {
				handler: async (ctx) => {
					const state = await readBootstrap(ctx);
					return {
						state,
						targetVersion: BOOTSTRAP_VERSION,
					};
				},
			},

			"setup:mark": {
				input: setupMarkInput,
				handler: async (ctx) => {
					const input = ctx.input as SetupMarkInput;
					const current = await readBootstrap(ctx);
					const next: BootstrapState = {
						version: input.lastError ? current.version : BOOTSTRAP_VERSION,
						completedSteps: Array.from(new Set(input.completedSteps)),
						lastRunAt: new Date().toISOString(),
						lastError: input.lastError,
					};
					await ctx.kv.set(BOOTSTRAP_STATE_KEY, next);
					return { state: next };
				},
			},

			// Setup utility routes — lightweight, no bootstrap gate.
			"admin:whoami": {
				handler: async (ctx) => {
					const user = ctx.user;
					if (!user) {
						throw new PluginRouteError(
							LEARN_ERRORS.UNAUTHENTICATED,
							"Authentication required",
							401,
						);
					}
					return {
						id: user.id,
						email: user.email,
						name: user.name,
						role: user.role,
						isAdmin: user.role >= Role.ADMIN,
					};
				},
			} as PluginRoute<unknown>,

			// Wave 3 routes — composed from per-task modules per §26 ownership.
			// Cast widens each module's `PluginRoute<SpecificInput>` entries to
			// `PluginRoute<unknown>` so the invariant Record index signature accepts them.
			...(enrollmentRoutes as Record<string, PluginRoute<unknown>>),
			...(progressRoutes as Record<string, PluginRoute<unknown>>),
			...(curriculumRoutes as Record<string, PluginRoute<unknown>>),
			...(quizRoutes as Record<string, PluginRoute<unknown>>),
			...(instructorLessonRoutes as Record<string, PluginRoute<unknown>>),
			...(instructorTopicRoutes as Record<string, PluginRoute<unknown>>),
			...(certificateRoutesStudent as Record<string, PluginRoute<unknown>>),
			...(certificateRoutesPublic as Record<string, PluginRoute<unknown>>),
			...(cohortRoutes as Record<string, PluginRoute<unknown>>),
			...(instructorAssignmentRoutes as Record<string, PluginRoute<unknown>>),

			// Wave 4 routes — analytics backends (D33 defers admin UI to v2).
			...(instructorAnalyticsRoutes as Record<string, PluginRoute<unknown>>),
			...(adminAnalyticsRoutes as Record<string, PluginRoute<unknown>>),

			// Wave 5 routes — public catalog (§6.2, D22).
			...(catalogRoutes as Record<string, PluginRoute<unknown>>),

			// Wave 6 routes — admin settings (T24 / §16.8).
			...(adminSettingsRoutes as Record<string, PluginRoute<unknown>>),

			// Backfill route — called by setup wizard step `seed-content-index`
			// (BOOTSTRAP_VERSION 3 / AUDIT C3).
			"admin:seed-content-index": {
				handler: async (ctx) => {
					const result = await backfillContentIndexReconciler(ctx);
					if (!result.ok) {
						throw new Error(`Backfill failed: ${result.error.message}`);
					}
					return {
						lessonsUpserted: result.data.lessonsUpserted,
						topicsUpserted: result.data.topicsUpserted,
						errors: result.data.errors,
					};
				},
			} as PluginRoute<unknown>,
		},
	});
}

export default createPlugin;

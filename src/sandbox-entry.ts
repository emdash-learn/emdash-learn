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

import { definePlugin } from "emdash";
import type { PluginContext, PluginRoute } from "emdash";
import { z } from "astro/zod";

import {
	BOOTSTRAP_VERSION,
	COURSES_COLLECTION_SLUG,
	DEFAULT_SETTINGS,
	LESSONS_COLLECTION_SLUG,
	PLUGIN_ID,
	PLUGIN_VERSION,
} from "./constants.js";
import { BOOTSTRAP_STATE_KEY, settingKey } from "./kv-keys.js";
import { cohortRoutes } from "./routes/instructor-cohorts.js";
import { instructorAssignmentRoutes } from "./routes/instructor-assignments.js";
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

		storage: {
			enrollments: {
				indexes: ["userId", "courseId", "enrolledAt"],
				uniqueIndexes: [["userId", "courseId"]],
			},
			progress: {
				indexes: [
					"userId",
					"courseId",
					"lessonId",
					["userId", "courseId"],
					"completedAt",
				],
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
		},

		admin: {
			entry: "@emdash/lms-core/admin",
			pages: [{ path: "/setup", label: "Setup", icon: "wand" }],
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
				// Emdash core drops plugin storage automatically; we only need
				// to drop the authored content collections. Lessons first so
				// lesson→course references don't block the courses drop.
				const dropCollection = async (slug: string): Promise<void> => {
					try {
						const res = await fetch(
							ctx.url(`/_emdash/api/schema/collections/${encodeURIComponent(slug)}?force=true`),
							{ method: "DELETE" },
						);
						if (!res.ok && res.status !== 404) {
							ctx.log.warn(`Failed to drop collection ${slug}: ${res.status}`);
						}
					} catch (err) {
						ctx.log.error(`Collection drop failed for ${slug}`, err);
					}
				};
				await dropCollection(LESSONS_COLLECTION_SLUG);
				await dropCollection(COURSES_COLLECTION_SLUG);
				ctx.log.info(`${PLUGIN_ID} uninstalled with deleteData=true.`);
			},
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

			// Wave 3 routes — composed from per-task modules per §26 ownership.
			// Cast widens each module's `PluginRoute<SpecificInput>` entries to
			// `PluginRoute<unknown>` so the invariant Record index signature accepts them.
			...(enrollmentRoutes as Record<string, PluginRoute<unknown>>),
			...(progressRoutes as Record<string, PluginRoute<unknown>>),
			...(curriculumRoutes as Record<string, PluginRoute<unknown>>),
			...(quizRoutes as Record<string, PluginRoute<unknown>>),
			...(certificateRoutesStudent as Record<string, PluginRoute<unknown>>),
			...(certificateRoutesPublic as Record<string, PluginRoute<unknown>>),
			...(cohortRoutes as Record<string, PluginRoute<unknown>>),
			...(instructorAssignmentRoutes as Record<string, PluginRoute<unknown>>),
		},
	});
}

export default createPlugin;

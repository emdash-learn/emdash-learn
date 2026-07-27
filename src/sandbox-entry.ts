import { elements } from "@emdash-cms/blocks";
import { definePlugin } from "emdash";
import type { PluginRoute } from "emdash";

import { PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";
import {
	contentAfterDelete,
	contentAfterPublish,
	contentAfterSave,
	contentAfterUnpublish,
} from "./hooks/content.js";
import { createReportingMaintenanceHooks } from "./hooks/reporting-maintenance.js";
import { BOOTSTRAP_STATE_KEY } from "./kv-keys.js";
import { LEARN_PLUGIN_CONTRACT } from "./plugin-contract.js";
import { backfillContentIndex } from "./reconcilers/backfill-content-index.js";
import { createAssessmentRoutes } from "./routes/assessment.js";
import { createEngagementReportingRoutes } from "./routes/engagement-reporting.js";
import { publishedCourseRoutes } from "./routes/published-courses.js";
import { createSetupRoutes } from "./routes/setup.js";
import { withSetupGate } from "./routes/setup-gated.js";
import { createLearnRuntimeServices } from "./runtime/services.js";
import { ensureInstallationDigestSecret } from "./security/installation-digest.js";
import { convergeSetup } from "./setup/orchestrator.js";
import { createServerSchemaClient } from "./setup/server-schema-client.js";
import type { BootstrapState } from "./types/storage.js";

/**
 * Route factories retain their precise input types for direct tests. Runtime
 * composition deliberately erases those invariant generics after every route
 * has supplied its own Zod boundary; EmDash re-validates that schema before
 * invoking the handler.
 */
function runtimeRoutes(routes: object): Record<string, PluginRoute> {
	// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- intentional composition-seam type erasure described above
	return routes as Record<string, PluginRoute>;
}

export function createPlugin() {
	const services = createLearnRuntimeServices();
	const reportingMaintenance = createReportingMaintenanceHooks({
		createReporting: (ctx) => services.createReporting(ctx),
	});
	const setupRoutes = createSetupRoutes({
		async converge(ctx) {
			const result = await convergeSetup({
				schema: createServerSchemaClient(ctx),
				repairProjection: () => backfillContentIndex(ctx),
				persistState: (state) => ctx.kv.set(BOOTSTRAP_STATE_KEY, state),
			});
			await reportingMaintenance.onLifecycle({}, ctx);
			return result;
		},
	});
	const gatedRoutes = withSetupGate({
		...runtimeRoutes(publishedCourseRoutes),
		...runtimeRoutes(createAssessmentRoutes(services)),
		...runtimeRoutes(createEngagementReportingRoutes(services)),
	});

	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: LEARN_PLUGIN_CONTRACT.capabilities,

		storage: LEARN_PLUGIN_CONTRACT.storage,

		admin: {
			entry: "@emdash/lms-core/admin",
			pages: LEARN_PLUGIN_CONTRACT.adminPages,
			portableTextBlocks: [
				{
					type: LEARN_PLUGIN_CONTRACT.block.type,
					label: LEARN_PLUGIN_CONTRACT.block.label,
					icon: LEARN_PLUGIN_CONTRACT.block.icon,
					description: LEARN_PLUGIN_CONTRACT.block.description,
					fields: [
						elements.textInput(LEARN_PLUGIN_CONTRACT.block.courseIdField, "Course ID", {
							placeholder: "course_…",
						}),
						elements.textInput(LEARN_PLUGIN_CONTRACT.block.checkIdField, "Knowledge check ID", {
							placeholder: "kc_…",
						}),
					],
				},
			],
		},

		hooks: {
			"plugin:install": async (_event, ctx) => {
				await ensureInstallationDigestSecret(ctx.kv);
				const existing = await ctx.kv.get(BOOTSTRAP_STATE_KEY);
				if (existing === null) {
					await ctx.kv.set(BOOTSTRAP_STATE_KEY, {
						version: 0,
						completedSteps: [],
					} satisfies BootstrapState);
				}
				await reportingMaintenance.onInstall({}, ctx);
				ctx.log.info(`${PLUGIN_ID} installed; run the setup wizard to provision course content.`);
			},

			"plugin:activate": (event, ctx) => reportingMaintenance.onLifecycle(event, ctx),

			"plugin:uninstall": async (event, ctx) => {
				if (!event.deleteData) {
					ctx.log.info(
						`${PLUGIN_ID} uninstalled; authored content and plugin data were preserved.`,
					);
					return;
				}
				ctx.log.info(
					`${PLUGIN_ID} uninstalled with plugin-owned data deletion; ` +
						"administrator-owned Course and Lesson content was preserved.",
				);
			},

			"content:afterSave": contentAfterSave,
			"content:afterPublish": contentAfterPublish,
			"content:afterUnpublish": contentAfterUnpublish,
			"content:afterDelete": contentAfterDelete,

			cron: {
				timeout: 120_000,
				handler: (event, ctx) => reportingMaintenance.onCron(event, ctx),
			},
		},

		routes: {
			...runtimeRoutes(setupRoutes),
			...gatedRoutes,
		},
	});
}

export default createPlugin;

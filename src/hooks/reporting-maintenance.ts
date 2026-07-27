import type { PluginContext } from "emdash";

import type { EngagementReporting } from "../modules/engagement-reporting/index.js";

export const REPORTING_RETENTION_TASK_NAME = "reporting-daily-retention";
export const REPORTING_RETENTION_SCHEDULE = "5 1 * * *";

export interface ReportingMaintenanceDependencies {
	createReporting(ctx: PluginContext): EngagementReporting | Promise<EngagementReporting>;
}

export interface ReportingMaintenanceCronEvent {
	name: string;
	data?: Record<string, unknown>;
	scheduledAt: string;
}

export interface ReportingMaintenanceHooks {
	onInstall(event: unknown, ctx: PluginContext): Promise<void>;
	onLifecycle(event: unknown, ctx: PluginContext): Promise<void>;
	onCron(event: ReportingMaintenanceCronEvent, ctx: PluginContext): Promise<void>;
}

export function createReportingMaintenanceHooks(
	dependencies: ReportingMaintenanceDependencies,
): ReportingMaintenanceHooks {
	async function schedule(ctx: PluginContext): Promise<void> {
		if (!ctx.cron) {
			ctx.log.warn("Reporting maintenance was not scheduled because cron is unavailable.", {
				task: REPORTING_RETENTION_TASK_NAME,
			});
			return;
		}
		try {
			await ctx.cron.schedule(REPORTING_RETENTION_TASK_NAME, {
				schedule: REPORTING_RETENTION_SCHEDULE,
			});
		} catch (error) {
			ctx.log.warn("Reporting maintenance scheduling failed; learning remains available.", {
				task: REPORTING_RETENTION_TASK_NAME,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		async onInstall(_event, ctx) {
			await schedule(ctx);
		},
		async onLifecycle(_event, ctx) {
			await schedule(ctx);
		},
		async onCron(event, ctx) {
			if (event.name !== REPORTING_RETENTION_TASK_NAME) return;
			try {
				const reporting = await dependencies.createReporting(ctx);
				await reporting.pruneExpired();
			} catch (error) {
				ctx.log.warn("Reporting retention failed; learning remains available.", {
					task: REPORTING_RETENTION_TASK_NAME,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
	};
}

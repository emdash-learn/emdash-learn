import type { PluginContext } from "emdash";
import { describe, expect, it, vi } from "vitest";

import type { EngagementReporting } from "../../../src/modules/engagement-reporting/index.js";
import {
	createReportingMaintenanceHooks,
	REPORTING_RETENTION_SCHEDULE,
	REPORTING_RETENTION_TASK_NAME,
} from "../../../src/hooks/reporting-maintenance.js";
import { createRouteContext } from "../../utils/route-context.js";

interface ScheduledTask {
	name: string;
	schedule: string;
	data: Record<string, unknown> | undefined;
}

function reporting(
	pruneExpired: EngagementReporting["pruneExpired"] = async () => ({
		observationsPruned: 0,
	}),
): EngagementReporting {
	return {
		async observe() {},
		async query() {
			return { calculatedThrough: null, courses: [] };
		},
		pruneExpired,
	};
}

function pluginContext(scheduled: ScheduledTask[]): PluginContext {
	return {
		...createRouteContext(undefined),
		cron: {
			async schedule(name, options) {
				scheduled.push({
					name,
					schedule: options.schedule,
					data: options.data,
				});
			},
			async cancel() {},
			async list() {
				return [];
			},
		},
	};
}

describe("reporting maintenance hooks", () => {
	it("schedules one named daily retention task on install and lifecycle", async () => {
		const scheduled: ScheduledTask[] = [];
		const hooks = createReportingMaintenanceHooks({
			createReporting: () => reporting(),
		});
		const ctx = pluginContext(scheduled);

		await hooks.onInstall({}, ctx);
		await hooks.onLifecycle({}, ctx);

		expect(scheduled).toEqual([
			{
				name: REPORTING_RETENTION_TASK_NAME,
				schedule: REPORTING_RETENTION_SCHEDULE,
				data: undefined,
			},
			{
				name: REPORTING_RETENTION_TASK_NAME,
				schedule: REPORTING_RETENTION_SCHEDULE,
				data: undefined,
			},
		]);
	});

	it("reports when lifecycle cannot access the cron scheduler", async () => {
		const warnings: Array<{ message: string; data: unknown }> = [];
		const ctx = createRouteContext(undefined, {
			onWarn(message, data) {
				warnings.push({ message, data });
			},
		});
		const hooks = createReportingMaintenanceHooks({
			createReporting: () => reporting(),
		});

		await expect(hooks.onLifecycle({}, ctx)).resolves.toBeUndefined();

		expect(warnings).toEqual([
			{
				message: "Reporting maintenance was not scheduled because cron is unavailable.",
				data: { task: REPORTING_RETENTION_TASK_NAME },
			},
		]);
	});

	it("warns without aborting lifecycle when Core cannot schedule the task", async () => {
		const warnings: Array<{ message: string; data: unknown }> = [];
		const ctx: PluginContext = {
			...createRouteContext(undefined, {
				onWarn(message, data) {
					warnings.push({ message, data });
				},
			}),
			cron: {
				async schedule() {
					throw new Error("scheduler storage unavailable");
				},
				async cancel() {},
				async list() {
					return [];
				},
			},
		};
		const hooks = createReportingMaintenanceHooks({
			createReporting: () => reporting(),
		});

		await expect(hooks.onLifecycle({}, ctx)).resolves.toBeUndefined();

		expect(warnings).toEqual([
			{
				message: "Reporting maintenance scheduling failed; learning remains available.",
				data: {
					task: REPORTING_RETENTION_TASK_NAME,
					error: "scheduler storage unavailable",
				},
			},
		]);
	});

	it("runs one retention prune for the matching daily task and ignores other tasks", async () => {
		const pruneExpired = vi.fn(async () => ({ observationsPruned: 3 }));
		let reportingCreations = 0;
		const hooks = createReportingMaintenanceHooks({
			createReporting() {
				reportingCreations += 1;
				return reporting(pruneExpired);
			},
		});
		const ctx = pluginContext([]);

		await hooks.onCron(
			{
				name: "another-plugin-task",
				scheduledAt: "2026-07-26T01:05:00.000Z",
			},
			ctx,
		);
		await hooks.onCron(
			{
				name: REPORTING_RETENTION_TASK_NAME,
				scheduledAt: "2026-07-26T01:05:00.000Z",
			},
			ctx,
		);

		expect(reportingCreations).toBe(1);
		expect(pruneExpired).toHaveBeenCalledOnce();
	});

	it("keeps pruning best-effort and retries safely on the next daily run", async () => {
		const warnings: Array<{ message: string; data: unknown }> = [];
		const pruneExpired = vi
			.fn<EngagementReporting["pruneExpired"]>()
			.mockRejectedValueOnce(new Error("observation storage unavailable"))
			.mockResolvedValueOnce({ observationsPruned: 4 });
		const hooks = createReportingMaintenanceHooks({
			createReporting: () => reporting(pruneExpired),
		});
		const ctx = pluginContext([]);
		ctx.log.warn = (message, data) => {
			warnings.push({ message, data });
		};
		const event = {
			name: REPORTING_RETENTION_TASK_NAME,
			scheduledAt: "2026-07-26T01:05:00.000Z",
		};

		await expect(hooks.onCron(event, ctx)).resolves.toBeUndefined();
		await expect(hooks.onCron(event, ctx)).resolves.toBeUndefined();

		expect(pruneExpired).toHaveBeenCalledTimes(2);
		expect(warnings).toEqual([
			{
				message: "Reporting retention failed; learning remains available.",
				data: {
					task: REPORTING_RETENTION_TASK_NAME,
					error: "observation storage unavailable",
				},
			},
		]);
	});
});

import { describe, expect, it } from "vitest";

import { lmsCorePlugin } from "../../src/index.js";
import { createPlugin } from "../../src/sandbox-entry.js";

const PUBLIC_ROUTES = [
	"catalog",
	"course:get",
	"lesson:get",
	"assessment:present",
	"assessment:self-grade",
	"engagement:observe",
] as const;

const LEARNER_ROUTES = [
	"assessment:submit-attempt",
	"assessment:attempts",
	"learning:complete-lesson",
	"learning:progress",
	"learning:import-device-progress",
	"privacy:erase-my-data",
] as const;

const EDITOR_ROUTES = [
	"assessment:draft-list",
	"assessment:draft-create",
	"assessment:draft-get",
	"assessment:draft-update",
	"assessment:draft-delete",
	"assessment:publish",
	"assessment:archive",
] as const;

const ADMIN_ROUTES = ["setup:state", "setup:run", "reporting:query"] as const;

describe("Learn plugin scope", () => {
	it("keeps descriptor and runtime capabilities canonical and identical", () => {
		const descriptor = lmsCorePlugin();
		const runtime = createPlugin();

		expect(descriptor.capabilities).toEqual(["content:read"]);
		expect(runtime.capabilities).toEqual(descriptor.capabilities);
		expect(descriptor.allowedHosts).toEqual([]);
	});

	it("registers only the supported admin surfaces", () => {
		const descriptor = lmsCorePlugin();
		const paths = descriptor.adminPages?.map((page) => page.path) ?? [];

		expect(paths).toEqual(["/", "/checks", "/reports", "/setup"]);
		expect(paths.every((path) => !path.includes(":"))).toBe(true);
	});

	it("owns only assessment, progress, reporting, and content-projection data", () => {
		const runtime = createPlugin();

		expect(new Set(Object.keys(runtime.storage))).toEqual(
			new Set([
				"assessment_attempts",
				"assessment_drafts",
				"assessment_heads",
				"assessment_revisions",
				"course_content_index",
				"engagement_observations",
				"lesson_completions",
			]),
		);
	});

	it("exposes the exact publishing, learning, assessment, reporting, and setup routes", () => {
		const runtime = createPlugin();
		const routes = runtime.routes;

		expect(new Set(Object.keys(routes))).toEqual(
			new Set([...PUBLIC_ROUTES, ...LEARNER_ROUTES, ...EDITOR_ROUTES, ...ADMIN_ROUTES]),
		);

		for (const name of PUBLIC_ROUTES) {
			expect(routes[name]?.public).toBe(true);
			expect(routes[name]?.permission).toBeUndefined();
		}
		for (const name of LEARNER_ROUTES) {
			expect(routes[name]?.public).not.toBe(true);
			expect(routes[name]?.permission).toBe("content:read");
		}
		for (const name of EDITOR_ROUTES) {
			expect(routes[name]?.public).not.toBe(true);
			expect(routes[name]?.permission).toBe("content:edit_any");
		}
		for (const name of ADMIN_ROUTES) {
			expect(routes[name]?.public).not.toBe(true);
			expect(routes[name]?.permission).toBe("plugins:manage");
		}
	});
});

import { describe, expect, it } from "vitest";

import { lmsCorePlugin } from "../../src/index.js";
import { LEARN_PLUGIN_CONTRACT } from "../../src/plugin-contract.js";
import { createPlugin } from "../../src/sandbox-entry.js";

describe("canonical plugin contract", () => {
	it("keeps descriptor and runtime capabilities and admin pages identical", () => {
		const descriptor = lmsCorePlugin();
		const runtime = createPlugin();

		expect(descriptor.capabilities).toEqual(LEARN_PLUGIN_CONTRACT.capabilities);
		expect(runtime.capabilities).toEqual(LEARN_PLUGIN_CONTRACT.capabilities);
		expect(descriptor.adminPages).toEqual(LEARN_PLUGIN_CONTRACT.adminPages);
		expect(runtime.admin.pages).toEqual(LEARN_PLUGIN_CONTRACT.adminPages);
		expect(descriptor.allowedHosts).toEqual([]);
	});

	it("declares every authoritative store from one contract", () => {
		const runtime = createPlugin();

		expect(Object.keys(runtime.storage)).toEqual(Object.keys(LEARN_PLUGIN_CONTRACT.storage));
		expect(Object.keys(runtime.storage)).toEqual([
			"course_content_index",
			"assessment_drafts",
			"assessment_revisions",
			"assessment_heads",
			"engagement_observations",
		]);
	});

	it("indexes retained anonymous engagement for bounded reporting queries", () => {
		const indexes = LEARN_PLUGIN_CONTRACT.storage.engagement_observations.indexes;
		expect(indexes).toEqual(expect.arrayContaining(["day", "courseId", "type"]));
		expect(indexes).not.toEqual(expect.arrayContaining(["actorKind", "actorKey"]));
	});

	it("keeps the Portable Text block name and field canonical", () => {
		const runtime = createPlugin();
		const block = runtime.admin.portableTextBlocks?.[0];

		expect(block?.type).toBe(LEARN_PLUGIN_CONTRACT.block.type);
		expect(block?.fields.map((field) => field.action_id)).toEqual([
			LEARN_PLUGIN_CONTRACT.block.courseIdField,
			LEARN_PLUGIN_CONTRACT.block.checkIdField,
		]);
	});
});

import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/astro/KnowledgeCheckBlock.astro", () => ({
	default: (): null => null,
}));

import { blockComponents } from "../../../src/astro/index.js";
import { createPlugin } from "../../../src/sandbox-entry.js";

interface TextInputElement {
	type: string;
	action_id: string;
	label: string;
	placeholder?: string;
}

describe("knowledge-check Portable Text block", () => {
	it("registers one answer-safe knowledge-check block", () => {
		const plugin = createPlugin();
		const blocks = plugin.admin.portableTextBlocks ?? [];

		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			type: "learnKnowledgeCheck",
			label: "Knowledge check",
			icon: "list-checks",
		});
		expect(blocks[0]?.description).toMatch(/published knowledge check/i);
	});

	it("collects the course and knowledge-check ids needed for attribution", () => {
		const block = createPlugin().admin.portableTextBlocks?.[0];
		expect(block?.fields).toHaveLength(2);

		const courseField = block?.fields?.[0] as TextInputElement | undefined;
		expect(courseField).toMatchObject({
			type: "text_input",
			action_id: "courseId",
			label: "Course ID",
		});
		const checkField = block?.fields?.[1] as TextInputElement | undefined;
		expect(checkField).toMatchObject({
			type: "text_input",
			action_id: "checkId",
			label: "Knowledge check ID",
		});
	});

	it("exports its Astro renderer under the same block type", () => {
		expect(blockComponents["learnKnowledgeCheck"]).toBeDefined();
		expect(Object.keys(blockComponents)).toEqual(["learnKnowledgeCheck"]);
	});
});

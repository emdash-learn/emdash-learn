/**
 * Smoke test for T16 — verifies the `lmsQuiz` Portable Text block ships both
 * an admin-side slash-command registration (via `admin.portableTextBlocks`)
 * and a site-side Astro renderer (via `blockComponents`).
 *
 * The admin/editor flow and real hydration are covered by T21 and the demo
 * site (T26); here we just confirm the wiring is present.
 */

import { describe, expect, it, vi } from "vitest";

// `.astro` files are compiled by Astro's Vite plugin at the consumer site;
// in this Node-only test we stub the module so the transitive import in
// `src/astro/index.ts` succeeds. The factory is hoisted above all imports,
// so any helpers must be declared inline.
// eslint-disable-next-line unicorn/consistent-function-scoping
vi.mock("../../../src/astro/QuizBlock.astro", () => ({
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

describe("T16 — lmsQuiz Portable Text block", () => {
	it("registers the slash-command entry under admin.portableTextBlocks", () => {
		const plugin = createPlugin();
		const blocks = plugin.admin.portableTextBlocks ?? [];
		expect(blocks).toHaveLength(1);
		const quiz = blocks[0];
		expect(quiz?.type).toBe("lmsQuiz");
		expect(quiz?.label).toBe("Quiz");
		expect(quiz?.description).toMatch(/quiz/i);
		expect(quiz?.icon).toBe("list-checks");
	});

	it("collects the quizId via a single textInput field", () => {
		const plugin = createPlugin();
		const quiz = plugin.admin.portableTextBlocks?.[0];
		expect(quiz?.fields).toHaveLength(1);
		const field = quiz?.fields?.[0] as TextInputElement | undefined;
		expect(field?.type).toBe("text_input");
		expect(field?.action_id).toBe("quizId");
		expect(field?.label).toBe("Quiz ID");
	});

	it("exports a site-side renderer for the lmsQuiz block", () => {
		expect(blockComponents["lmsQuiz"]).toBeDefined();
	});
});

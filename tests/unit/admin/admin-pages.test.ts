import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { pages, widgets } from "../../../src/admin.js";
import OverviewPage from "../../../src/admin/OverviewPage.js";

describe("reduced admin page registry", () => {
	it("registers only exact paths supported by EmDash core", () => {
		expect(Object.keys(pages)).toEqual(["/", "/checks", "/reports", "/setup"]);
		expect(Object.keys(pages).every((path) => !path.includes(":"))).toBe(true);
		expect(Object.keys(pages)).not.toContain("/quizzes");
		expect(widgets).toEqual({});
	});

	it("links Knowledge Checks to the canonical admin path", () => {
		const markup = renderToStaticMarkup(createElement(OverviewPage));

		expect(markup).toContain('href="/_emdash/admin/plugins/lms-core/checks"');
		expect(markup).toContain('href="/_emdash/admin/plugins/lms-core/reports"');
		expect(markup).not.toContain("/quizzes");
		expect(markup).not.toContain("Deliberately stateless");
	});
});

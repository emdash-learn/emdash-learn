import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SetupView } from "../../../src/admin/SetupWizardPage.js";

describe("SetupView", () => {
	it("shows trusted server verification and never offers content deletion", () => {
		const markup = renderToStaticMarkup(
			createElement(SetupView, {
				state: {
					version: 4,
					completedSteps: ["collection:courses", "fields:courses"],
					lastRunAt: "2026-07-26T12:00:00.000Z",
					verification: {
						contractVersion: 4,
						schema: "compatible",
						projection: "repaired",
					},
				},
				targetVersion: 4,
				running: false,
				error: null,
				result: {
					schemaWrites: 0,
					projection: { errors: 0, lessonsUpserted: 3 },
				},
				onRun: vi.fn(),
				onRefresh: vi.fn(),
			}),
		);

		expect(markup).toContain("Setup verified");
		expect(markup).toContain("3 lesson records reconciled");
		expect(markup).not.toContain("Drop plugin data");
		expect(markup).not.toContain("delete all courses");
	});
});

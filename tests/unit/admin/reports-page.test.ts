import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReportsView, reportQueryFromFilters } from "../../../src/admin/ReportsPage.js";
import ReportsPage from "../../../src/admin/ReportsPage.js";

describe("ReportsPage filters", () => {
	it("converts inclusive calendar dates to the route's exact UTC range", () => {
		expect(
			reportQueryFromFilters({
				startDate: "2026-07-20",
				endDate: "2026-07-26",
				courseId: " course-1 ",
			}),
		).toEqual({
			from: "2026-07-20T00:00:00.000Z",
			to: "2026-07-27T00:00:00.000Z",
			courseId: "course-1",
		});
		expect(
			reportQueryFromFilters({
				startDate: "2026-07-26",
				endDate: "2026-07-26",
				courseId: " ",
			}),
		).toEqual({
			from: "2026-07-26T00:00:00.000Z",
			to: "2026-07-27T00:00:00.000Z",
		});
	});

	it("rejects an impossible calendar date instead of normalizing it", () => {
		expect(() =>
			reportQueryFromFilters({
				startDate: "2026-02-30",
				endDate: "2026-03-01",
				courseId: "",
			}),
		).toThrowError("Choose valid start and end dates.");
	});

	it("rejects an end date before the start date", () => {
		expect(() =>
			reportQueryFromFilters({
				startDate: "2026-07-27",
				endDate: "2026-07-26",
				courseId: "",
			}),
		).toThrowError("End date must be on or after start date.");
	});
});

describe("ReportsView", () => {
	it("presents anonymous engagement, self-check, and freshness semantics", () => {
		const markup = renderToStaticMarkup(
			createElement(ReportsView, {
				filters: {
					startDate: "2026-07-20",
					endDate: "2026-07-26",
					courseId: "",
				},
				state: {
					kind: "ready",
					query: {
						from: "2026-07-20T00:00:00.000Z",
						to: "2026-07-27T00:00:00.000Z",
					},
					report: {
						calculatedThrough: "2026-07-26T12:00:00.000Z",
						courses: [
							{
								courseId: "course-1",
								opens: 18,
								lessonOpens: 14,
								checkOpens: 8,
								checkSubmissions: 4,
								passedSubmissions: 3,
								scoreBands: [
									{
										minimum: 80,
										maximum: 89,
										count: 3,
									},
									{
										minimum: 100,
										maximum: 100,
										count: 1,
									},
								],
							},
						],
					},
				},
				now: "2026-07-26T13:00:00.000Z",
				onFiltersChange() {},
				onSubmit() {},
				onRetry() {},
			}),
		);

		expect(markup).toContain("Course course-1");
		expect(markup).toContain("Course opens");
		expect(markup).toContain("18");
		expect(markup).toContain("Lesson opens");
		expect(markup).toContain("Check opens");
		expect(markup).toContain("Self-check submissions");
		expect(markup).toContain("Passed self-checks");
		expect(markup).toContain("Pass rate");
		expect(markup).toContain("75%");
		expect(markup).toContain("80–89%: 3");
		expect(markup).toContain("100%: 1");
		expect(markup).not.toContain("verified");
		expect(markup).not.toContain("Lesson completions");
		expect(markup).toContain('dateTime="2026-07-26T12:00:00.000Z"');
		expect(markup).toContain(
			"Metrics are anonymous directional browser observations, not unique visitors.",
		);
		expect(markup).toContain(
			"Calculated through is the report snapshot time, not the latest visitor activity.",
		);
	});

	it("announces loading progress accessibly", () => {
		const markup = renderToStaticMarkup(
			createElement(ReportsView, {
				filters: {
					startDate: "2026-07-20",
					endDate: "2026-07-26",
					courseId: "",
				},
				state: { kind: "loading" },
				now: "2026-07-26T13:00:00.000Z",
				onFiltersChange() {},
				onSubmit() {},
				onRetry() {},
			}),
		);

		expect(markup).toContain('role="status"');
		expect(markup).toContain('aria-live="polite"');
		expect(markup).toContain("Loading engagement report…");
	});

	it("shows the calculation watermark even when the exact report is empty", () => {
		const markup = renderToStaticMarkup(
			createElement(ReportsView, {
				filters: {
					startDate: "2026-07-20",
					endDate: "2026-07-26",
					courseId: "course-empty",
				},
				state: {
					kind: "ready",
					query: {
						from: "2026-07-20T00:00:00.000Z",
						to: "2026-07-27T00:00:00.000Z",
						courseId: "course-empty",
					},
					report: {
						calculatedThrough: "2026-07-26T12:00:00.000Z",
						courses: [],
					},
				},
				now: "2026-07-26T13:00:00.000Z",
				onFiltersChange() {},
				onSubmit() {},
				onRetry() {},
			}),
		);

		expect(markup).toContain('role="status"');
		expect(markup).toContain("No engagement activity matched these filters.");
		expect(markup).toContain("Data is current.");
		expect(markup).toContain('dateTime="2026-07-26T12:00:00.000Z"');
		expect(markup).not.toContain("Freshness is unavailable");
	});

	it("announces route failures and offers a retry action", () => {
		const markup = renderToStaticMarkup(
			createElement(ReportsView, {
				filters: {
					startDate: "2026-07-20",
					endDate: "2026-07-26",
					courseId: "",
				},
				state: { kind: "error", message: "Reporting storage is unavailable." },
				now: "2026-07-26T13:00:00.000Z",
				onFiltersChange() {},
				onSubmit() {},
				onRetry() {},
			}),
		);

		expect(markup).toContain('role="alert"');
		expect(markup).toContain("Reporting storage is unavailable.");
		expect(markup).toContain("Retry report");
	});

	it("warns when calculated data trails the report coverage target by more than a day", () => {
		const markup = renderToStaticMarkup(
			createElement(ReportsView, {
				filters: {
					startDate: "2026-07-20",
					endDate: "2026-07-26",
					courseId: "",
				},
				state: {
					kind: "ready",
					query: {
						from: "2026-07-20T00:00:00.000Z",
						to: "2026-07-27T00:00:00.000Z",
					},
					report: {
						calculatedThrough: "2026-07-24T10:00:00.000Z",
						courses: [
							{
								courseId: "course-1",
								opens: 1,
								lessonOpens: 0,
								checkOpens: 0,
								checkSubmissions: 0,
								passedSubmissions: 0,
							},
						],
					},
				},
				now: "2026-07-26T13:00:00.000Z",
				onFiltersChange() {},
				onSubmit() {},
				onRetry() {},
			}),
		);

		expect(markup).toContain("Data may be stale.");
		expect(markup).toContain('dateTime="2026-07-24T10:00:00.000Z"');
	});
});

describe("ReportsPage", () => {
	it("exports a registry-ready orchestrator with a seven-day inclusive default range", () => {
		const markup = renderToStaticMarkup(
			createElement(ReportsPage, {
				now: () => new Date("2026-07-26T13:00:00.000Z"),
			}),
		);

		expect(markup).toContain('value="2026-07-20"');
		expect(markup).toContain('value="2026-07-26"');
		expect(markup).toContain("Loading engagement report…");
	});
});

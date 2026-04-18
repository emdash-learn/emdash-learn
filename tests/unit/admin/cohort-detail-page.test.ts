/**
 * Unit tests for `src/admin/CohortDetailPage.tsx` (T22).
 *
 * Covers the pure helpers the detail page uses: URL parsing, date
 * formatting, capacity-line rendering, and the CSV → email-list parser
 * (which mirrors the route-side parser so the user sees what we're about
 * to submit, pre-flight).
 */

import { describe, expect, it } from "vitest";

import {
	formatCapacityLine,
	formatShortDate,
	parseCohortIdFromPath,
	parseEmailList,
} from "../../../src/admin/CohortDetailPage.js";

describe("parseCohortIdFromPath", () => {
	it("extracts the cohortId from an admin-shell URL", () => {
		expect(
			parseCohortIdFromPath(
				"/_emdash/admin/plugins/lms-core/cohorts/coh_abc123",
			),
		).toBe("coh_abc123");
	});

	it("stops at the next path segment", () => {
		expect(
			parseCohortIdFromPath(
				"/_emdash/admin/plugins/lms-core/cohorts/coh_abc123/edit",
			),
		).toBe("coh_abc123");
	});

	it("decodes percent-encoded ids", () => {
		expect(
			parseCohortIdFromPath(
				`/_emdash/admin/plugins/lms-core/cohorts/${encodeURIComponent("coh_abc/weird")}`,
			),
		).toBe("coh_abc/weird");
	});

	it("returns null for unrelated paths", () => {
		expect(parseCohortIdFromPath("/some/other/route")).toBeNull();
		expect(
			parseCohortIdFromPath("/_emdash/admin/plugins/lms-core/courses/c1"),
		).toBeNull();
	});

	it("returns null when the id segment is empty", () => {
		expect(
			parseCohortIdFromPath("/_emdash/admin/plugins/lms-core/cohorts/"),
		).toBeNull();
	});
});

describe("formatShortDate", () => {
	it("renders a UTC-stable '<d> <mon> <yyyy>' form", () => {
		expect(formatShortDate("2026-05-01T00:00:00Z")).toBe("1 May 2026");
	});

	it("falls back to the raw string when unparseable", () => {
		expect(formatShortDate("not-a-date")).toBe("not-a-date");
	});
});

describe("formatCapacityLine", () => {
	it("includes seats and current members when capacity is set", () => {
		expect(formatCapacityLine(34, 50)).toBe(
			"50 seats · Current members: 34",
		);
	});

	it("omits the seats figure when capacity is unset", () => {
		expect(formatCapacityLine(12, undefined)).toBe("Current members: 12");
	});
});

describe("parseEmailList", () => {
	it("splits on newlines and commas, trimming whitespace", () => {
		expect(
			parseEmailList("alice@example.com\nbob@example.com, carol@example.com"),
		).toEqual(["alice@example.com", "bob@example.com", "carol@example.com"]);
	});

	it("drops empty tokens", () => {
		expect(parseEmailList("\n\nalice@example.com\n\n")).toEqual([
			"alice@example.com",
		]);
	});

	it("de-dupes case-insensitively, preserving the first-seen casing", () => {
		expect(
			parseEmailList("Alice@Example.com\nalice@example.com\nBOB@X.Z"),
		).toEqual(["Alice@Example.com", "BOB@X.Z"]);
	});

	it("returns an empty array for blank input", () => {
		expect(parseEmailList("")).toEqual([]);
		expect(parseEmailList("   \n ,, \n")).toEqual([]);
	});
});

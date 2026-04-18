/**
 * Unit tests for `src/admin/QuizListPage.tsx` (T21).
 *
 * Covers pure formatter + href helpers — full component rendering is covered
 * by manual QA against emdash's admin shell (vitest runs in node with no DOM).
 */

import { describe, expect, it } from "vitest";

import {
	formatCount,
	formatShortDate,
	quizEditHref,
} from "../../../src/admin/QuizListPage.js";

describe("formatCount", () => {
	it("formats integers with thousands separators", () => {
		expect(formatCount(0)).toBe("0");
		expect(formatCount(12)).toBe("12");
		expect(formatCount(1_234)).toBe("1,234");
		expect(formatCount(1_000_000)).toBe("1,000,000");
	});

	it("returns em-dash for non-finite input", () => {
		expect(formatCount(Number.NaN)).toBe("—");
		expect(formatCount(Number.POSITIVE_INFINITY)).toBe("—");
	});
});

describe("formatShortDate", () => {
	it("renders 'D Mon YYYY' in UTC for a parseable ISO timestamp", () => {
		expect(formatShortDate("2026-04-18T12:00:00Z")).toBe("18 Apr 2026");
		expect(formatShortDate("2025-01-01T00:00:00Z")).toBe("1 Jan 2025");
	});

	it("returns the raw string when the timestamp is unparseable", () => {
		expect(formatShortDate("not-a-date")).toBe("not-a-date");
	});
});

describe("quizEditHref", () => {
	it("percent-encodes the quiz id", () => {
		expect(quizEditHref("q1")).toBe(
			"/_emdash/admin/plugins/lms-core/quizzes/q1",
		);
		expect(quizEditHref("q with space")).toBe(
			"/_emdash/admin/plugins/lms-core/quizzes/q%20with%20space",
		);
	});
});

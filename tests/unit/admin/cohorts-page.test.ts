/**
 * Unit tests for `src/admin/CohortsPage.tsx` (T22).
 *
 * Full component rendering is covered by manual QA against emdash's admin
 * shell — the vitest config is a node environment with no DOM, so we keep
 * the unit test surface on the pure formatter / derivation helpers.
 */

import { describe, expect, it } from "vitest";

import {
	formatCapacity,
	formatDateRange,
	formatShortDate,
	isOverCapacity,
} from "../../../src/admin/CohortsPage.js";

describe("formatShortDate", () => {
	it("renders a UTC-stable '<d> <mon> <yyyy>' form", () => {
		expect(formatShortDate("2026-05-01T00:00:00Z")).toBe("1 May 2026");
		expect(formatShortDate("2026-12-31T23:59:59Z")).toBe("31 Dec 2026");
	});

	it("falls back to the raw string when unparseable", () => {
		expect(formatShortDate("not-a-date")).toBe("not-a-date");
	});
});

describe("formatDateRange", () => {
	it("renders '<start> – <end>' when both are provided", () => {
		expect(formatDateRange("2026-05-01T00:00:00Z", "2026-07-31T00:00:00Z")).toBe(
			"1 May 2026 – 31 Jul 2026",
		);
	});

	it("renders 'Starts <date>' when only start is known", () => {
		expect(formatDateRange("2026-05-01T00:00:00Z", undefined)).toBe("Starts 1 May 2026");
	});

	it("renders 'Ends <date>' when only end is known", () => {
		expect(formatDateRange(undefined, "2026-07-31T00:00:00Z")).toBe("Ends 31 Jul 2026");
	});

	it("renders an em-dash when neither is set", () => {
		expect(formatDateRange(undefined, undefined)).toBe("—");
	});
});

describe("formatCapacity", () => {
	it("renders 'n / capacity' when a capacity exists", () => {
		expect(formatCapacity(34, 50)).toBe("34 / 50");
		expect(formatCapacity(0, 50)).toBe("0 / 50");
	});

	it("renders just the member count when no capacity is set", () => {
		expect(formatCapacity(34, undefined)).toBe("34");
	});
});

describe("isOverCapacity", () => {
	it("flags overshoot cases only (D43 at-capacity overage)", () => {
		expect(isOverCapacity(51, 50)).toBe(true);
		expect(isOverCapacity(50, 50)).toBe(false);
		expect(isOverCapacity(49, 50)).toBe(false);
	});

	it("returns false when no capacity is set", () => {
		expect(isOverCapacity(1_000_000, undefined)).toBe(false);
	});
});

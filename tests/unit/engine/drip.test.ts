/**
 * Pure-function unit tests for `engine/drip.ts` (T07).
 *
 * Covers the 4 combinations required by §18.4 / T07 acceptance:
 *   (immediate, no scheduled_at)
 *   (immediate, scheduled_at set)
 *   (relative,  no scheduled_at)
 *   (relative,  scheduled_at set)
 * plus boundary cases (0-day drip, past-scheduled-date, missing fields).
 */

import { describe, expect, test } from "vitest";

import { isUnlocked, unlocksAt } from "../../../src/engine/drip.js";

const enrollment = { enrolledAt: "2026-06-01T00:00:00.000Z" };

describe("drip.unlocksAt — four-cell matrix", () => {
	test("immediate + no scheduled_at: unlocks at enrolledAt", () => {
		expect(unlocksAt(enrollment, { dripOffsetDays: 7 }, "immediate")).toBe(
			"2026-06-01T00:00:00.000Z",
		);
	});

	test("immediate + scheduled_at in the future: scheduled_at wins (floor)", () => {
		expect(
			unlocksAt(
				enrollment,
				{ dripOffsetDays: 7, scheduledAt: "2026-07-01T00:00:00.000Z" },
				"immediate",
			),
		).toBe("2026-07-01T00:00:00.000Z");
	});

	test("relative + no scheduled_at: unlocks at enrolledAt + dripOffsetDays", () => {
		expect(unlocksAt(enrollment, { dripOffsetDays: 7 }, "relative")).toBe(
			"2026-06-08T00:00:00.000Z",
		);
	});

	test("relative + scheduled_at later than drip: scheduled_at wins", () => {
		expect(
			unlocksAt(
				enrollment,
				{ dripOffsetDays: 7, scheduledAt: "2026-07-01T00:00:00.000Z" },
				"relative",
			),
		).toBe("2026-07-01T00:00:00.000Z");
	});
});

describe("drip.unlocksAt — edge cases", () => {
	test("relative with dripOffsetDays=0 is equivalent to immediate", () => {
		expect(unlocksAt(enrollment, { dripOffsetDays: 0 }, "relative")).toBe(
			"2026-06-01T00:00:00.000Z",
		);
	});

	test("scheduled_at earlier than the computed base does not lower the unlock", () => {
		expect(
			unlocksAt(
				enrollment,
				{ dripOffsetDays: 14, scheduledAt: "2026-06-02T00:00:00.000Z" },
				"relative",
			),
		).toBe("2026-06-15T00:00:00.000Z");
	});

	test("missing dripOffsetDays defaults to immediate-style unlock", () => {
		expect(unlocksAt(enrollment, {}, "relative")).toBe("2026-06-01T00:00:00.000Z");
	});
});

describe("drip.isUnlocked", () => {
	test("true after the computed unlock time", () => {
		const now = new Date("2026-06-09T00:00:00.000Z");
		expect(isUnlocked(enrollment, { dripOffsetDays: 7 }, "relative", now)).toBe(true);
	});

	test("false before the computed unlock time", () => {
		const now = new Date("2026-06-02T00:00:00.000Z");
		expect(isUnlocked(enrollment, { dripOffsetDays: 7 }, "relative", now)).toBe(false);
	});
});

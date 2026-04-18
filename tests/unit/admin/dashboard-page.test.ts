/**
 * Unit tests for `src/admin/DashboardPage.tsx` (T19).
 *
 * Exercises the pure formatter / description helpers the page uses to render
 * stats, tables, and the recent-activity feed. Full component rendering is
 * covered by manual QA against emdash's admin shell — the vitest config is a
 * node environment with no DOM, so we keep the unit test surface on the pure
 * pieces.
 */

import { describe, expect, it } from "vitest";

import {
	describeActivity,
	formatCount,
	formatPercent,
	formatRelativeTime,
} from "../../../src/admin/DashboardPage.js";
import type { ActivityItem } from "../../../src/admin/api-client.js";

describe("formatPercent", () => {
	it("rounds to the nearest integer and appends %", () => {
		expect(formatPercent(67.3)).toBe("67%");
		expect(formatPercent(67.6)).toBe("68%");
		expect(formatPercent(0)).toBe("0%");
		expect(formatPercent(100)).toBe("100%");
	});

	it("returns em-dash for non-finite inputs", () => {
		expect(formatPercent(Number.NaN)).toBe("—");
		expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("—");
	});
});

describe("formatCount", () => {
	it("formats with thousands separators", () => {
		expect(formatCount(0)).toBe("0");
		expect(formatCount(42)).toBe("42");
		expect(formatCount(1284)).toBe("1,284");
		expect(formatCount(1_000_000)).toBe("1,000,000");
	});

	it("returns em-dash for non-finite inputs", () => {
		expect(formatCount(Number.NaN)).toBe("—");
	});
});

describe("formatRelativeTime", () => {
	const now = Date.parse("2026-04-18T12:00:00Z");

	it("renders seconds, minutes, hours, days, months, years", () => {
		expect(formatRelativeTime("2026-04-18T11:59:45Z", now)).toBe("15s ago");
		expect(formatRelativeTime("2026-04-18T11:45:00Z", now)).toBe("15m ago");
		expect(formatRelativeTime("2026-04-18T09:00:00Z", now)).toBe("3h ago");
		expect(formatRelativeTime("2026-04-15T12:00:00Z", now)).toBe("3d ago");
		expect(formatRelativeTime("2026-02-17T12:00:00Z", now)).toBe("2mo ago");
		expect(formatRelativeTime("2024-04-18T12:00:00Z", now)).toBe("2y ago");
	});

	it("treats future timestamps as 'just now'", () => {
		expect(formatRelativeTime("2026-04-18T12:00:01Z", now)).toBe("just now");
	});

	it("returns the raw string when the timestamp is unparseable", () => {
		expect(formatRelativeTime("not-a-date", now)).toBe("not-a-date");
	});
});

describe("describeActivity", () => {
	const base = {
		userId: "usr_abcd1234zz",
		userName: "Maya",
		courseId: "c1",
		courseTitle: "React Fundamentals",
		at: "2026-04-18T12:00:00Z",
	};

	it("renders human sentences for each activity type", () => {
		expect(describeActivity({ ...base, type: "enrolled" } satisfies ActivityItem)).toBe(
			"Maya enrolled in React Fundamentals",
		);

		expect(
			describeActivity({
				...base,
				type: "completed-course",
			} satisfies ActivityItem),
		).toBe("Maya completed React Fundamentals — certificate issued");

		expect(
			describeActivity({
				...base,
				type: "lesson-completed",
				lessonId: "l1",
			} satisfies ActivityItem),
		).toBe("Maya completed a lesson in React Fundamentals");

		expect(
			describeActivity({
				...base,
				type: "quiz-submitted",
				quizId: "q1",
			} satisfies ActivityItem),
		).toBe("Maya submitted a quiz in React Fundamentals");
	});

	it("falls back to a userId-derived label when userName is absent", () => {
		const item: ActivityItem = {
			type: "enrolled",
			userId: "usr_abcd1234zz",
			at: base.at,
			courseTitle: "Advanced SQL",
		};
		expect(describeActivity(item)).toBe("User usr_abcd enrolled in Advanced SQL");
	});

	it("falls back to a generic course label when courseTitle is missing", () => {
		const item: ActivityItem = {
			type: "quiz-submitted",
			userId: "usr_1",
			userName: "Josh",
			quizId: "q1",
			at: base.at,
		};
		expect(describeActivity(item)).toBe("Josh submitted a quiz in a course");
	});
});

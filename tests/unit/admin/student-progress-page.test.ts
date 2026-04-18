/**
 * Unit tests for `src/admin/StudentProgressPage.tsx` (T25).
 *
 * Exercises the pure URL-parsing + formatter helpers the page uses. Full
 * component rendering is covered by manual QA against emdash's admin shell —
 * the vitest config is a node environment with no DOM, so we keep the unit
 * test surface on the pure pieces.
 */

import { describe, expect, it } from "vitest";

import {
	courseStatus,
	formatCount,
	formatPercent,
	formatRelativeTime,
	formatShortDate,
	parseStudentIdFromPath,
} from "../../../src/admin/StudentProgressPage.js";
import type { StudentProgress } from "../../../src/admin/api-client.js";

type StudentCourse = StudentProgress["courses"][number];

describe("parseStudentIdFromPath", () => {
	it("extracts the userId from the canonical admin path", () => {
		expect(
			parseStudentIdFromPath(
				"/_emdash/admin/plugins/lms-core/students/usr_abc123",
			),
		).toBe("usr_abc123");
	});

	it("ignores trailing segments and query strings after the id", () => {
		// The admin shell passes the pathname only; anything after a slash is
		// treated as a sub-route that we ignore for extraction purposes.
		expect(
			parseStudentIdFromPath(
				"/_emdash/admin/plugins/lms-core/students/usr_abc/extra",
			),
		).toBe("usr_abc");
	});

	it("decodes percent-encoded ids", () => {
		expect(
			parseStudentIdFromPath(
				"/_emdash/admin/plugins/lms-core/students/usr%20with%20space",
			),
		).toBe("usr with space");
	});

	it("returns null when the prefix does not match", () => {
		expect(parseStudentIdFromPath("/_emdash/admin/dashboard")).toBeNull();
		expect(parseStudentIdFromPath("/students/usr_abc")).toBeNull();
		expect(
			parseStudentIdFromPath("/_emdash/admin/plugins/other/students/usr_abc"),
		).toBeNull();
	});

	it("returns null when the id segment is empty", () => {
		expect(
			parseStudentIdFromPath("/_emdash/admin/plugins/lms-core/students/"),
		).toBeNull();
		expect(
			parseStudentIdFromPath("/_emdash/admin/plugins/lms-core/students//foo"),
		).toBeNull();
	});

	it("returns null when the segment is an invalid percent-encoding", () => {
		expect(
			parseStudentIdFromPath("/_emdash/admin/plugins/lms-core/students/%ZZ"),
		).toBeNull();
	});
});

describe("formatPercent", () => {
	it("rounds to the nearest integer and appends %", () => {
		expect(formatPercent(12.3)).toBe("12%");
		expect(formatPercent(12.6)).toBe("13%");
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
		expect(formatCount(8)).toBe("8");
		expect(formatCount(1_284)).toBe("1,284");
	});

	it("returns em-dash for non-finite inputs", () => {
		expect(formatCount(Number.NaN)).toBe("—");
	});
});

describe("formatShortDate", () => {
	it("formats a UTC date as `D MMM YYYY`", () => {
		expect(formatShortDate("2026-04-18T12:00:00Z")).toBe("18 Apr 2026");
		expect(formatShortDate("2026-01-02T00:00:00Z")).toBe("2 Jan 2026");
	});

	it("returns the raw string when the timestamp is unparseable", () => {
		expect(formatShortDate("not-a-date")).toBe("not-a-date");
	});
});

describe("formatRelativeTime", () => {
	const now = Date.parse("2026-04-18T12:00:00Z");

	it("renders seconds, minutes, hours, days", () => {
		expect(formatRelativeTime("2026-04-18T11:59:45Z", now)).toBe("15s ago");
		expect(formatRelativeTime("2026-04-18T10:00:00Z", now)).toBe("2h ago");
		expect(formatRelativeTime("2026-04-15T12:00:00Z", now)).toBe("3d ago");
	});

	it("treats future timestamps as 'just now'", () => {
		expect(formatRelativeTime("2026-04-18T12:00:01Z", now)).toBe("just now");
	});

	it("returns the raw string when the timestamp is unparseable", () => {
		expect(formatRelativeTime("nope", now)).toBe("nope");
	});
});

describe("courseStatus", () => {
	const base: StudentCourse = {
		courseId: "course_1",
		courseTitle: "React Fundamentals",
		enrolledAt: "2026-04-12T09:00:00Z",
		percentComplete: 0,
		lessonsCompleted: 0,
		lessonsTotal: 12,
	};

	it("reports 'completed' when the enrollment has a completedAt timestamp", () => {
		expect(
			courseStatus({ ...base, completedAt: "2026-04-17T09:00:00Z" }),
		).toBe("completed");
	});

	it("reports 'in-progress' when any lesson is complete or percent > 0", () => {
		expect(courseStatus({ ...base, lessonsCompleted: 1 })).toBe("in-progress");
		expect(courseStatus({ ...base, percentComplete: 5 })).toBe("in-progress");
	});

	it("reports 'not-started' when nothing has happened yet", () => {
		expect(courseStatus(base)).toBe("not-started");
	});
});

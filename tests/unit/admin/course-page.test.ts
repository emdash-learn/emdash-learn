import { describe, expect, it } from "vitest";

import {
	averageStudentProgress,
	collectLessonIds,
	courseCatalogStatus,
	enrollmentWindowSummary,
	parseCourseIdFromPath,
	sortMatrixStudents,
} from "../../../src/admin/CoursePage.js";

describe("parseCourseIdFromPath", () => {
	it("extracts the course id from the admin URL", () => {
		expect(
			parseCourseIdFromPath("/_emdash/admin/plugins/lms-core/courses/course_123"),
		).toBe("course_123");
		expect(
			parseCourseIdFromPath("/_emdash/admin/plugins/lms-core/courses/course%2F123/details"),
		).toBe("course/123");
	});

	it("returns null for unrelated or incomplete paths", () => {
		expect(parseCourseIdFromPath("/_emdash/admin/plugins/lms-core/courses/")).toBeNull();
		expect(parseCourseIdFromPath("/_emdash/admin/plugins/lms-core/")).toBeNull();
		expect(parseCourseIdFromPath("/courses/course_123")).toBeNull();
	});
});

describe("courseCatalogStatus", () => {
	it("distinguishes published catalog entries from missing ones", () => {
		expect(courseCatalogStatus(null)).toBe("not-in-catalog");
		expect(
			courseCatalogStatus({
				id: "c1",
				title: "Course",
				slug: "course",
				publishedAt: "2026-04-18T12:00:00Z",
			}),
		).toBe("published");
	});
});

describe("enrollmentWindowSummary", () => {
	it("summarizes the configured enrollment window", () => {
		expect(enrollmentWindowSummary(null)).toMatch("Unavailable");
		expect(
			enrollmentWindowSummary({ id: "c1", title: "Course", enrollmentOpen: true }),
		).toBe("Open now");
		expect(
			enrollmentWindowSummary({ id: "c1", title: "Course", enrollmentOpen: false }),
		).toBe("Closed");
		expect(
			enrollmentWindowSummary({
				id: "c1",
				title: "Course",
				enrollmentOpen: true,
				enrollmentOpensAt: "2026-04-01T00:00:00Z",
				enrollmentClosesAt: "2026-04-30T00:00:00Z",
			}),
		).toBe("1 Apr 2026 → 30 Apr 2026");
	});
});

describe("matrix helpers", () => {
	const students = [
		{
			userId: "u3",
			name: "Cora",
			lessonProgress: { lesson_b: 100, lesson_a: 100 },
		},
		{
			userId: "u1",
			name: "Alice",
			lessonProgress: { lesson_a: 100, lesson_b: 75 },
		},
		{
			userId: "u2",
			name: "Ben",
			lessonProgress: { lesson_a: 50 },
		},
	] as const;

	it("collects lesson ids in stable order", () => {
		expect(collectLessonIds(students)).toEqual(["lesson_a", "lesson_b"]);
	});

	it("computes average progress across a student's lessons", () => {
		expect(averageStudentProgress(students[0])).toBe(100);
		expect(averageStudentProgress(students[1])).toBe(87.5);
		expect(averageStudentProgress(students[2])).toBe(50);
	});

	it("sorts by name, average, and lesson-specific progress", () => {
		expect(sortMatrixStudents(students, { key: "name" }).map((student) => student.name)).toEqual([
			"Alice",
			"Ben",
			"Cora",
		]);

		expect(
			sortMatrixStudents(students, { key: "average" }, "desc").map((student) => student.name),
		).toEqual(["Cora", "Alice", "Ben"]);

		expect(
			sortMatrixStudents(students, { key: "lesson", lessonId: "lesson_b" }, "desc").map(
				(student) => student.name,
			),
		).toEqual(["Cora", "Alice", "Ben"]);
	});
});
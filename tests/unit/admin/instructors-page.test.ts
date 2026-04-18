/**
 * Unit tests for `src/admin/InstructorsPage.tsx` (T23).
 *
 * Following the T22 convention — vitest runs in a node env with no DOM, so
 * component rendering is validated by manual QA against the admin shell. We
 * test the pure derivation helpers that turn the `instructor:list` payload
 * into the label + grouped rows the §16.9 table renders.
 */

import { describe, expect, it } from "vitest";

import type { InstructorListItem } from "../../../src/admin/api-client.js";
import {
	courseLabel,
	formatAssignment,
	formatCoursesSummary,
	formatRole,
	groupByUser,
	userLabel,
} from "../../../src/admin/InstructorsPage.js";

function item(
	partial: Partial<InstructorListItem> & Pick<InstructorListItem, "userId" | "courseId" | "role">,
): InstructorListItem {
	return partial;
}

describe("formatRole", () => {
	it("capitalizes each instructor role", () => {
		expect(formatRole("lead")).toBe("Lead");
		expect(formatRole("co")).toBe("Co");
		expect(formatRole("ta")).toBe("TA");
	});
});

describe("userLabel", () => {
	it("prefers the hydrated name when present", () => {
		expect(
			userLabel(
				item({
					userId: "u1",
					courseId: "c1",
					role: "lead",
					userName: "Maya Okafor",
					userEmail: "maya@example.com",
				}),
			),
		).toBe("Maya Okafor");
	});

	it("falls back to email when name is missing", () => {
		expect(
			userLabel(
				item({
					userId: "u1",
					courseId: "c1",
					role: "lead",
					userEmail: "maya@example.com",
				}),
			),
		).toBe("maya@example.com");
	});

	it("falls back to userId when neither is available", () => {
		expect(userLabel(item({ userId: "u1", courseId: "c1", role: "lead" }))).toBe(
			"u1",
		);
	});
});

describe("courseLabel", () => {
	it("prefers the hydrated title", () => {
		expect(
			courseLabel(
				item({
					userId: "u1",
					courseId: "c1",
					role: "lead",
					courseTitle: "React Fundamentals",
				}),
			),
		).toBe("React Fundamentals");
	});

	it("falls back to courseId when title is missing", () => {
		expect(courseLabel(item({ userId: "u1", courseId: "c1", role: "lead" }))).toBe(
			"c1",
		);
	});
});

describe("formatAssignment", () => {
	it("renders '<title> (<role>)' matching the §16.9 wireframe", () => {
		expect(
			formatAssignment(
				item({
					userId: "u1",
					courseId: "c1",
					role: "lead",
					courseTitle: "React Fundamentals",
				}),
			),
		).toBe("React Fundamentals (lead)");
	});

	it("uses courseId when the title is missing", () => {
		expect(formatAssignment(item({ userId: "u1", courseId: "c1", role: "co" }))).toBe(
			"c1 (co)",
		);
	});
});

describe("formatCoursesSummary", () => {
	it("joins assignments with a comma", () => {
		expect(
			formatCoursesSummary([
				item({
					userId: "u1",
					courseId: "c1",
					role: "lead",
					courseTitle: "React Fundamentals",
				}),
				item({ userId: "u1", courseId: "c2", role: "co", courseTitle: "SQL" }),
			]),
		).toBe("React Fundamentals (lead), SQL (co)");
	});

	it("renders an em-dash when the user has no assignments", () => {
		expect(formatCoursesSummary([])).toBe("—");
	});
});

describe("groupByUser", () => {
	it("groups assignments by userId and sorts by user label", () => {
		const groups = groupByUser([
			item({
				userId: "u_ben",
				courseId: "c_sql",
				role: "lead",
				userName: "Ben Tanaka",
				courseTitle: "Advanced SQL",
			}),
			item({
				userId: "u_maya",
				courseId: "c_react",
				role: "lead",
				userName: "Maya Okafor",
				courseTitle: "React Fundamentals",
			}),
			item({
				userId: "u_maya",
				courseId: "c_sql_intro",
				role: "co",
				userName: "Maya Okafor",
				courseTitle: "SQL",
			}),
		]);

		expect(groups.map((g) => g.label)).toEqual(["Ben Tanaka", "Maya Okafor"]);
		const maya = groups.find((g) => g.userId === "u_maya");
		expect(maya?.assignments.map((a) => a.courseTitle)).toEqual([
			"React Fundamentals",
			"SQL",
		]);
	});

	it("carries email through to the group when present", () => {
		const [group] = groupByUser([
			item({
				userId: "u1",
				courseId: "c1",
				role: "lead",
				userName: "Lin Park",
				userEmail: "lin@example.com",
			}),
		]);
		expect(group?.email).toBe("lin@example.com");
	});

	it("returns an empty array for empty input", () => {
		expect(groupByUser([])).toEqual([]);
	});
});

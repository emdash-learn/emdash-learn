import { describe, expect, it } from "vitest";

import {
	createDeviceProgressStore,
	DeviceProgressError,
	type BrowserStorage,
} from "../../../src/browser/device-progress.js";

function createStorage(): BrowserStorage {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
		removeItem: (key) => values.delete(key),
	};
}

describe("device progress", () => {
	it("persists idempotent lesson completion across browser sessions", () => {
		const storage = createStorage();
		const firstSession = createDeviceProgressStore(storage, {
			now: () => "2026-07-26T16:00:00.000Z",
		});

		firstSession.completeLesson("course-typescript", "lesson-types");
		firstSession.completeLesson("course-typescript", "lesson-types");

		const nextSession = createDeviceProgressStore(storage, {
			now: () => "2026-07-27T09:00:00.000Z",
		});
		expect(nextSession.getCourse("course-typescript")).toEqual({
			courseId: "course-typescript",
			completedLessonIds: ["lesson-types"],
			selfChecks: [],
			updatedAt: "2026-07-26T16:00:00.000Z",
		});
	});

	it("keeps self-check results local and exports/imports a versioned snapshot", () => {
		const source = createDeviceProgressStore(createStorage(), {
			now: () => "2026-07-26T16:00:00.000Z",
		});
		source.completeLesson("course-typescript", "lesson-types");
		source.recordSelfCheck("course-typescript", {
			checkId: "check-types",
			revisionId: "revision-2",
			score: 80,
			passed: true,
		});
		const exported = source.exportSnapshot();
		const target = createDeviceProgressStore(createStorage(), {
			now: () => "2026-07-27T09:00:00.000Z",
		});

		expect(target.importSnapshot(exported)).toEqual({
			importedCourses: 1,
			importedLessons: 1,
			importedSelfChecks: 1,
		});
		expect(target.getCourse("course-typescript")).toEqual({
			courseId: "course-typescript",
			completedLessonIds: ["lesson-types"],
			selfChecks: [
				{
					checkId: "check-types",
					revisionId: "revision-2",
					score: 80,
					passed: true,
					completedAt: "2026-07-26T16:00:00.000Z",
				},
			],
			updatedAt: "2026-07-27T09:00:00.000Z",
		});
	});

	it("recovers safely from corrupt local storage and supports reset", () => {
		const storage = createStorage();
		storage.setItem("emdash-learn:device-progress:v1", "{not-json");
		const progress = createDeviceProgressStore(storage, {
			now: () => "2026-07-26T16:00:00.000Z",
		});

		expect(progress.getCourse("course-typescript")).toBeNull();
		progress.completeLesson("course-typescript", "lesson-types");
		progress.resetCourse("course-typescript");
		expect(progress.getCourse("course-typescript")).toBeNull();
	});

	it("rejects invalid self-check booleans before corrupting stored progress", () => {
		const progress = createDeviceProgressStore(createStorage());

		expect(() =>
			progress.recordSelfCheck("course-typescript", {
				checkId: "check-types",
				revisionId: "revision-2",
				score: 80,
				// Exercise the JavaScript runtime boundary, not only TypeScript callers.
				// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- deliberately malformed JavaScript input
				passed: "yes" as unknown as boolean,
			}),
		).toThrow(DeviceProgressError);
		expect(progress.getCourse("course-typescript")).toBeNull();
	});

	it("rejects an import whose merged lesson count exceeds the storage bound", () => {
		const progress = createDeviceProgressStore(createStorage(), {
			now: () => "2026-07-26T16:00:00.000Z",
		});
		for (let index = 0; index < 1000; index += 1) {
			progress.completeLesson("course-typescript", `existing-${index}`);
		}
		const incoming = JSON.stringify({
			version: 1,
			courses: [
				{
					courseId: "course-typescript",
					completedLessonIds: ["one-too-many"],
					selfChecks: [],
					updatedAt: "2026-07-26T16:00:00.000Z",
				},
			],
		});

		expect(() => progress.importSnapshot(incoming)).toThrow(DeviceProgressError);
		expect(progress.getCourse("course-typescript")?.completedLessonIds).toHaveLength(1000);
	});
});

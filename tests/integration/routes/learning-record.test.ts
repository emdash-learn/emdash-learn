import { describe, expect, it, vi } from "vitest";

import type { EngagementReporting } from "../../../src/modules/engagement-reporting/index.js";
import type { LearningRecord } from "../../../src/modules/learning-record/index.js";
import {
	completeLessonInput,
	courseProgressInput,
	createLearningRecordRoutes,
	importDeviceProgressInput,
} from "../../../src/routes/learning-record.js";
import { createRouteContext } from "../../utils/route-context.js";

function unusedLearningRecord(): LearningRecord {
	return {
		async completeLesson() {
			throw new Error("Unexpected completeLesson");
		},
		async getCourseProgress() {
			throw new Error("Unexpected getCourseProgress");
		},
		async importDeviceProgress() {
			throw new Error("Unexpected importDeviceProgress");
		},
		async eraseLearner() {
			throw new Error("Unexpected eraseLearner");
		},
	};
}

function unusedReporting(): EngagementReporting {
	return {
		async observe() {},
		async query() {
			return { calculatedThrough: null, courses: [] };
		},
		async pruneExpired() {
			return { observationsPruned: 0 };
		},
	};
}

describe("Learning Record routes", () => {
	it("rejects an absent principal before creating personalized services", async () => {
		const createLearningRecord = vi.fn(() => unusedLearningRecord());
		const routes = createLearningRecordRoutes({
			createLearningRecord,
			createReporting: () => unusedReporting(),
		});

		await expect(
			routes["learning:progress"].handler(
				createRouteContext({ courseId: "course-typescript" }, { principal: null }),
			),
		).rejects.toMatchObject({
			code: "LEARN_UNAUTHENTICATED",
			status: 401,
		});
		expect(createLearningRecord).not.toHaveBeenCalled();
	});

	it("derives completion ownership from the trusted principal and fails open on reporting", async () => {
		const completeLesson = vi.fn(async () => ({
			newlyCompleted: true,
			completedAt: "2026-07-26T17:00:00.000Z",
			progress: {
				courseId: "course-typescript",
				totalLessons: 2,
				completedLessons: 1,
				percentComplete: 50,
			},
		}));
		const observe = vi.fn(async () => {
			throw new Error("telemetry unavailable");
		});
		const warn = vi.fn();
		const routes = createLearningRecordRoutes({
			createLearningRecord: () => ({ ...unusedLearningRecord(), completeLesson }),
			createReporting: () => ({ ...unusedReporting(), observe }),
		});

		const result = await routes["learning:complete-lesson"].handler(
			createRouteContext(
				{ lessonId: "lesson-types", operationId: "operation-1" },
				{
					principal: { id: "core-user-42" },
					onWarn: warn,
				},
			),
		);

		expect(result).toMatchObject({ newlyCompleted: true });
		expect(completeLesson).toHaveBeenCalledWith(
			{ kind: "verified", learnerId: "core-user-42" },
			{ lessonId: "lesson-types", operationId: "operation-1" },
		);
		expect(observe).toHaveBeenCalledWith({
			type: "lesson_completed",
			courseId: "course-typescript",
			lessonId: "lesson-types",
			actor: { kind: "verified", learnerId: "core-user-42" },
		});
		expect(warn).toHaveBeenCalledOnce();
		expect(routes["learning:complete-lesson"].permission).toBe("content:read");
	});

	it("exposes only own progress and device-completion import inputs", async () => {
		const getCourseProgress = vi.fn(async () => ({
			courseId: "course-typescript",
			totalLessons: 2,
			completedLessons: 1,
			percentComplete: 50,
		}));
		const importDeviceProgress = vi.fn(async () => ({
			importedLessons: 1,
			importedLessonIds: ["lesson-types"],
			ignoredLessons: 0,
			progress: {
				courseId: "course-typescript",
				totalLessons: 2,
				completedLessons: 2,
				percentComplete: 100,
			},
		}));
		const observe = vi.fn(async () => {});
		const routes = createLearningRecordRoutes({
			createLearningRecord: () => ({
				...unusedLearningRecord(),
				getCourseProgress,
				importDeviceProgress,
			}),
			createReporting: () => ({ ...unusedReporting(), observe }),
		});
		const principal = { id: "core-user-42" };

		await routes["learning:progress"].handler(
			createRouteContext({ courseId: "course-typescript" }, { principal }),
		);
		await routes["learning:import-device-progress"].handler(
			createRouteContext(
				{
					courseId: "course-typescript",
					lessonIds: ["lesson-types"],
					operationId: "import-1",
				},
				{ principal },
			),
		);

		expect(getCourseProgress).toHaveBeenCalledWith(
			{ kind: "verified", learnerId: "core-user-42" },
			{ courseId: "course-typescript" },
		);
		expect(importDeviceProgress).toHaveBeenCalledWith(
			{ kind: "verified", learnerId: "core-user-42" },
			{
				courseId: "course-typescript",
				lessonIds: ["lesson-types"],
				operationId: "import-1",
			},
		);
		expect(observe).toHaveBeenCalledWith({
			type: "lesson_completed",
			courseId: "course-typescript",
			lessonId: "lesson-types",
			actor: { kind: "verified", learnerId: "core-user-42" },
		});
		expect(routes["learning:progress"].permission).toBe("content:read");
		expect(routes["learning:import-device-progress"].permission).toBe("content:read");
		expect(
			completeLessonInput.safeParse({
				lessonId: "lesson-types",
				operationId: "00000000-0000-4000-8000-000000000001",
				learnerId: "attacker-selected",
			}).success,
		).toBe(false);
		expect(
			courseProgressInput.safeParse({
				courseId: "course-typescript",
				learnerId: "attacker-selected",
			}).success,
		).toBe(false);
		expect(
			importDeviceProgressInput.safeParse({
				courseId: "course-typescript",
				lessonIds: [],
				operationId: "00000000-0000-4000-8000-000000000001",
				learnerId: "attacker-selected",
			}).success,
		).toBe(false);
		expect(
			completeLessonInput.safeParse({
				lessonId: "lesson-types",
				operationId: "someone@example.test",
			}).success,
		).toBe(false);
	});
});

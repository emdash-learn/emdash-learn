import { describe, expect, it } from "vitest";

import {
	createLearningRecord,
	type CompletionFact,
	type CompletionFactStore,
	type LearningContent,
} from "../../../src/modules/learning-record/index.js";

function createContent(
	courses: Record<string, string[]>,
	lessonCourses: Record<string, string>,
): LearningContent {
	return {
		async getPublishedLesson(lessonId) {
			const courseId = lessonCourses[lessonId];
			return courseId && courses[courseId]?.includes(lessonId) ? { lessonId, courseId } : null;
		},
		async listPublishedLessons(courseId) {
			const lessonIds = courses[courseId];
			return lessonIds ? { courseId, lessonIds: [...lessonIds] } : null;
		},
	};
}

function createGate(expectedArrivals: number): {
	arrive(): Promise<void>;
} {
	let arrivals = 0;
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		async arrive() {
			arrivals += 1;
			if (arrivals === expectedArrivals) release?.();
			await gate;
		},
	};
}

function completionKey(learnerKey: string, lessonId: string): string {
	return `${learnerKey}:${lessonId}`;
}

function createCompletionStore(options: { raceFirstCreates?: boolean } = {}): CompletionFactStore {
	const facts = new Map<string, CompletionFact>();
	const createRaceGate = createGate(2);
	let gatedCreates = 0;
	return {
		async get(learnerKey, lessonId) {
			const existing = facts.get(completionKey(learnerKey, lessonId));
			return existing ? structuredClone(existing) : null;
		},
		async create(fact) {
			if (options.raceFirstCreates === true && gatedCreates < 2) {
				gatedCreates += 1;
				await createRaceGate.arrive();
			}
			const factKey = completionKey(fact.learnerKey, fact.lessonId);
			const existing = facts.get(factKey);
			if (existing) return { created: false, fact: structuredClone(existing) };
			const durable = structuredClone(fact);
			facts.set(factKey, durable);
			return { created: true, fact: structuredClone(durable) };
		},
		async listForLessons(learnerKey, lessonIds) {
			const currentLessons = new Set(lessonIds);
			return [...facts.values()]
				.filter((fact) => fact.learnerKey === learnerKey && currentLessons.has(fact.lessonId))
				.map((fact) => structuredClone(fact));
		},
		async deleteForLearner(learnerKey) {
			let deleted = 0;
			for (const [factKey, fact] of facts) {
				if (fact.learnerKey !== learnerKey) continue;
				facts.delete(factKey);
				deleted += 1;
			}
			return deleted;
		},
	};
}

const testHash = {
	async digest(value: string) {
		return `key:${value}`;
	},
};

describe("Learning Record", () => {
	it("keys persisted completion ownership without storing the core principal id", async () => {
		let stored: CompletionFact | null = null;
		const completions: CompletionFactStore = {
			async get() {
				return null;
			},
			async create(fact) {
				stored = structuredClone(fact);
				return { created: true, fact: structuredClone(fact) };
			},
			async listForLessons() {
				return stored ? [structuredClone(stored)] : [];
			},
			async deleteForLearner() {
				return 0;
			},
		};
		const dependencies = {
			content: createContent(
				{ "course-typescript": ["lesson-types"] },
				{ "lesson-types": "course-typescript" },
			),
			completions,
			clock: () => new Date("2026-07-26T13:00:00.000Z"),
			hash: {
				async digest() {
					return "installation-keyed-owner";
				},
			},
		};
		const learning = createLearningRecord(dependencies);

		await learning.completeLesson(
			{ kind: "verified", learnerId: "core-user-sensitive" },
			{ lessonId: "lesson-types", operationId: "complete-1" },
		);

		expect(JSON.stringify(stored)).not.toContain("core-user-sensitive");
		expect(stored).toMatchObject({ learnerKey: "installation-keyed-owner" });
	});

	it("completes a published lesson monotonically and derives current course progress", async () => {
		const learning = createLearningRecord({
			content: createContent(
				{ "course-typescript": ["lesson-types", "lesson-narrowing"] },
				{
					"lesson-types": "course-typescript",
					"lesson-narrowing": "course-typescript",
				},
			),
			completions: createCompletionStore(),
			clock: () => new Date("2026-07-26T13:00:00.000Z"),
			hash: testHash,
		});
		const learner = { kind: "verified", learnerId: "core-user-42" } as const;

		const first = await learning.completeLesson(learner, {
			lessonId: "lesson-types",
			operationId: "complete-1",
		});
		const retry = await learning.completeLesson(learner, {
			lessonId: "lesson-types",
			operationId: "complete-1",
		});

		expect(first).toEqual({
			newlyCompleted: true,
			completedAt: "2026-07-26T13:00:00.000Z",
			progress: {
				courseId: "course-typescript",
				totalLessons: 2,
				completedLessons: 1,
				percentComplete: 50,
			},
		});
		expect(retry).toEqual({
			...first,
			newlyCompleted: false,
		});
	});

	it("retains completion when a published lesson moves to another course", async () => {
		const courses: Record<string, string[]> = {
			"course-foundations": ["lesson-types"],
			"course-advanced": [],
		};
		const lessonCourses: Record<string, string> = {
			"lesson-types": "course-foundations",
		};
		const learning = createLearningRecord({
			content: createContent(courses, lessonCourses),
			completions: createCompletionStore(),
			clock: () => new Date("2026-07-26T13:00:00.000Z"),
			hash: testHash,
		});
		const learner = { kind: "verified", learnerId: "core-user-42" } as const;

		await learning.completeLesson(learner, {
			lessonId: "lesson-types",
			operationId: "complete-before-move",
		});
		courses["course-foundations"] = [];
		courses["course-advanced"] = ["lesson-types"];
		lessonCourses["lesson-types"] = "course-advanced";

		await expect(
			learning.completeLesson(learner, {
				lessonId: "lesson-types",
				operationId: "complete-after-move",
			}),
		).resolves.toEqual({
			newlyCompleted: false,
			completedAt: "2026-07-26T13:00:00.000Z",
			progress: {
				courseId: "course-advanced",
				totalLessons: 1,
				completedLessons: 1,
				percentComplete: 100,
			},
		});
	});

	it("converges simultaneous lesson completion calls on the first durable fact", async () => {
		const completions = createCompletionStore({
			raceFirstCreates: true,
		});
		let clockTick = 0;
		const learning = createLearningRecord({
			content: createContent(
				{ "course-typescript": ["lesson-types"] },
				{ "lesson-types": "course-typescript" },
			),
			completions,
			clock: () => new Date(Date.UTC(2026, 6, 26, 13, clockTick++)),
			hash: testHash,
		});
		const learner = { kind: "verified", learnerId: "core-user-42" } as const;

		const results = await Promise.all([
			learning.completeLesson(learner, {
				lessonId: "lesson-types",
				operationId: "4c02bb57-8192-46ef-81ac-a71f8db4ea62",
			}),
			learning.completeLesson(learner, {
				lessonId: "lesson-types",
				operationId: "cff93d77-83f0-48f6-a108-97c58ed42616",
			}),
		]);

		expect(results.filter(({ newlyCompleted }) => newlyCompleted)).toHaveLength(1);
		expect(results.filter(({ newlyCompleted }) => !newlyCompleted)).toHaveLength(1);
		expect(results[0]?.completedAt).toBe(results[1]?.completedAt);
		await expect(
			completions.get('key:["learner","core-user-42"]', "lesson-types"),
		).resolves.toMatchObject({
			completedAt: results[0]?.completedAt,
			operationId: "4c02bb57-8192-46ef-81ac-a71f8db4ea62",
			source: "learner",
		});
	});

	it("imports only current published device completions without promoting other local state", async () => {
		const learning = createLearningRecord({
			content: createContent(
				{ "course-typescript": ["lesson-types", "lesson-narrowing"] },
				{
					"lesson-types": "course-typescript",
					"lesson-narrowing": "course-typescript",
					"lesson-draft": "course-typescript",
				},
			),
			completions: createCompletionStore(),
			clock: () => new Date("2026-07-26T14:00:00.000Z"),
			hash: testHash,
		});
		const learner = { kind: "verified", learnerId: "core-user-42" } as const;

		const imported = await learning.importDeviceProgress(learner, {
			courseId: "course-typescript",
			lessonIds: ["lesson-types", "lesson-draft", "lesson-types"],
			operationId: "device-import-1",
		});
		const completedAgain = await learning.completeLesson(learner, {
			lessonId: "lesson-types",
			operationId: "complete-after-import",
		});

		expect(imported).toEqual({
			importedLessons: 1,
			importedLessonIds: ["lesson-types"],
			ignoredLessons: 2,
			progress: {
				courseId: "course-typescript",
				totalLessons: 2,
				completedLessons: 1,
				percentComplete: 50,
			},
		});
		expect(completedAgain).toEqual({
			newlyCompleted: false,
			completedAt: "2026-07-26T14:00:00.000Z",
			progress: imported.progress,
		});
	});

	it("converges simultaneous device imports and reports only the durable winner", async () => {
		const completions = createCompletionStore({ raceFirstCreates: true });
		let clockTick = 0;
		const learning = createLearningRecord({
			content: createContent(
				{ "course-typescript": ["lesson-types"] },
				{ "lesson-types": "course-typescript" },
			),
			completions,
			clock: () => new Date(Date.UTC(2026, 6, 26, 14, clockTick++)),
			hash: testHash,
		});
		const learner = { kind: "verified", learnerId: "core-user-42" } as const;

		const results = await Promise.all([
			learning.importDeviceProgress(learner, {
				courseId: "course-typescript",
				lessonIds: ["lesson-types"],
				operationId: "4c02bb57-8192-46ef-81ac-a71f8db4ea62",
			}),
			learning.importDeviceProgress(learner, {
				courseId: "course-typescript",
				lessonIds: ["lesson-types"],
				operationId: "cff93d77-83f0-48f6-a108-97c58ed42616",
			}),
		]);

		expect(results.filter(({ importedLessons }) => importedLessons === 1)).toHaveLength(1);
		expect(results.filter(({ importedLessons }) => importedLessons === 0)).toHaveLength(1);
		expect(results.map(({ importedLessonIds }) => importedLessonIds)).toEqual([
			["lesson-types"],
			[],
		]);
		await expect(
			completions.get('key:["learner","core-user-42"]', "lesson-types"),
		).resolves.toMatchObject({
			completedAt: "2026-07-26T14:00:00.000Z",
			operationId: "4c02bb57-8192-46ef-81ac-a71f8db4ea62",
			source: "device_import",
		});
	});

	it("converges learner completion and device import on one immutable fact", async () => {
		const completions = createCompletionStore({ raceFirstCreates: true });
		let clockTick = 0;
		const learning = createLearningRecord({
			content: createContent(
				{ "course-typescript": ["lesson-types"] },
				{ "lesson-types": "course-typescript" },
			),
			completions,
			clock: () => new Date(Date.UTC(2026, 6, 26, 16, clockTick++)),
			hash: testHash,
		});
		const learner = { kind: "verified", learnerId: "core-user-42" } as const;

		const [learnerResult, importResult] = await Promise.all([
			learning.completeLesson(learner, {
				lessonId: "lesson-types",
				operationId: "4c02bb57-8192-46ef-81ac-a71f8db4ea62",
			}),
			learning.importDeviceProgress(learner, {
				courseId: "course-typescript",
				lessonIds: ["lesson-types"],
				operationId: "cff93d77-83f0-48f6-a108-97c58ed42616",
			}),
		]);

		expect(learnerResult).toMatchObject({
			newlyCompleted: true,
			completedAt: "2026-07-26T16:00:00.000Z",
		});
		expect(importResult).toMatchObject({
			importedLessons: 0,
			importedLessonIds: [],
			ignoredLessons: 1,
		});
		await expect(
			completions.get('key:["learner","core-user-42"]', "lesson-types"),
		).resolves.toMatchObject({
			completedAt: "2026-07-26T16:00:00.000Z",
			operationId: "4c02bb57-8192-46ef-81ac-a71f8db4ea62",
			source: "learner",
		});
	});

	it("erases only the requesting learner's completion facts", async () => {
		const learning = createLearningRecord({
			content: createContent(
				{ "course-typescript": ["lesson-types", "lesson-narrowing"] },
				{
					"lesson-types": "course-typescript",
					"lesson-narrowing": "course-typescript",
				},
			),
			completions: createCompletionStore(),
			clock: () => new Date("2026-07-26T15:00:00.000Z"),
			hash: testHash,
		});
		const firstLearner = { kind: "verified", learnerId: "core-user-42" } as const;
		const secondLearner = { kind: "verified", learnerId: "core-user-99" } as const;
		await learning.completeLesson(firstLearner, {
			lessonId: "lesson-types",
			operationId: "complete-first",
		});
		await learning.completeLesson(secondLearner, {
			lessonId: "lesson-types",
			operationId: "complete-second",
		});

		await expect(learning.eraseLearner(firstLearner)).resolves.toEqual({
			deletedCompletions: 1,
		});
		await expect(
			learning.getCourseProgress(firstLearner, { courseId: "course-typescript" }),
		).resolves.toMatchObject({ completedLessons: 0 });
		await expect(
			learning.getCourseProgress(secondLearner, { courseId: "course-typescript" }),
		).resolves.toMatchObject({ completedLessons: 1 });
	});
});

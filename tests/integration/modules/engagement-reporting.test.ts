import { describe, expect, it } from "vitest";

import {
	createEngagementReporting,
	createNullEngagementReporting,
	type EngagementStore,
	type StoredEngagementObservation,
} from "../../../src/modules/engagement-reporting/index.js";

function createMemoryStore(): EngagementStore & {
	observations: Map<string, StoredEngagementObservation>;
} {
	const observations = new Map<string, StoredEngagementObservation>();
	return {
		observations,
		async appendObservation(observation) {
			observations.set(observation.id, structuredClone(observation));
		},
		async listObservations(input) {
			return [...observations.values()]
				.filter(
					(observation) =>
						observation.observedAt >= input.from && observation.observedAt < input.to,
				)
				.map((observation) => structuredClone(observation));
		},
		async deleteObservationsBefore(cutoff) {
			let deleted = 0;
			for (const [id, observation] of observations) {
				if (observation.observedAt >= cutoff) continue;
				observations.delete(id);
				deleted += 1;
			}
			return deleted;
		},
	};
}

function createReporting(store: EngagementStore, now = "2026-07-26T12:00:00.000Z") {
	return createEngagementReporting({
		store,
		clock: () => new Date(now),
		nextId: (() => {
			let value = 0;
			return () => `observation-${++value}`;
		})(),
	});
}

describe("Engagement Reporting", () => {
	it("aggregates anonymous directional activity and coarse result bands", async () => {
		const store = createMemoryStore();
		const reporting = createReporting(store);

		await reporting.observe({
			type: "course_opened",
			courseId: "course-typescript",
		});
		await reporting.observe({
			type: "lesson_opened",
			courseId: "course-typescript",
			lessonId: "lesson-types",
		});
		await reporting.observe({
			type: "check_opened",
			courseId: "course-typescript",
			checkId: "check-types",
		});
		await reporting.observe({
			type: "check_submitted",
			courseId: "course-typescript",
			checkId: "check-types",
			passed: true,
			score: 83,
		});
		await reporting.observe({
			type: "check_submitted",
			courseId: "course-typescript",
			checkId: "check-types",
			passed: false,
			score: 46,
		});
		await reporting.observe({
			type: "check_submitted",
			courseId: "course-typescript",
			checkId: "check-types",
			passed: true,
			score: 88,
		});

		await expect(
			reporting.query({
				from: "2026-07-26T00:00:00.000Z",
				to: "2026-07-27T00:00:00.000Z",
			}),
		).resolves.toEqual({
			calculatedThrough: "2026-07-26T12:00:00.000Z",
			courses: [
				{
					courseId: "course-typescript",
					opens: 1,
					lessonOpens: 1,
					checkOpens: 1,
					checkSubmissions: 3,
					passedSubmissions: 2,
					scoreBands: [
						{ minimum: 40, maximum: 49, count: 1 },
						{ minimum: 80, maximum: 89, count: 2 },
					],
				},
			],
		});
		expect([...store.observations.values()]).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					actorKind: expect.anything(),
				}),
			]),
		);
	});

	it("filters exact retained observations by Course", async () => {
		const store = createMemoryStore();
		const reporting = createReporting(store);
		await reporting.observe({ type: "course_opened", courseId: "course-b" });
		await reporting.observe({ type: "course_opened", courseId: "course-a" });
		await reporting.observe({ type: "course_opened", courseId: "course-b" });

		await expect(
			reporting.query({
				from: "2026-07-26T00:00:00.000Z",
				to: "2026-07-27T00:00:00.000Z",
				courseId: "course-b",
			}),
		).resolves.toMatchObject({
			courses: [{ courseId: "course-b", opens: 2 }],
		});
	});

	it("rejects ranges that are not increasing UTC-midnight boundaries", async () => {
		const reporting = createReporting(createMemoryStore());
		await expect(
			reporting.query({
				from: "2026-07-26T12:00:00.000Z",
				to: "2026-07-27T00:00:00.000Z",
			}),
		).rejects.toMatchObject({
			code: "LEARN_REPORT_INVALID_RANGE",
			status: 400,
		});
	});

	it("prunes only observations strictly older than the fixed 90-day cutoff", async () => {
		const store = createMemoryStore();
		for (const observation of [
			{
				id: "expired",
				type: "course_opened",
				courseId: "course-typescript",
				observedAt: "2026-04-27T11:59:59.999Z",
				day: "2026-04-27",
			},
			{
				id: "at-cutoff",
				type: "course_opened",
				courseId: "course-typescript",
				observedAt: "2026-04-27T12:00:00.000Z",
				day: "2026-04-27",
			},
			{
				id: "retained",
				type: "course_opened",
				courseId: "course-typescript",
				observedAt: "2026-07-26T12:00:00.000Z",
				day: "2026-07-26",
			},
		] satisfies StoredEngagementObservation[]) {
			store.observations.set(observation.id, observation);
		}
		const reporting = createReporting(store);

		await expect(reporting.pruneExpired()).resolves.toEqual({
			observationsPruned: 1,
		});
		expect([...store.observations.keys()]).toEqual(["at-cutoff", "retained"]);
		await expect(reporting.pruneExpired()).resolves.toEqual({
			observationsPruned: 0,
		});
	});

	it("marks even an empty exact report with the post-read calculation time", async () => {
		let now = new Date("2026-07-26T12:00:00.000Z");
		const store = createMemoryStore();
		const listObservations = store.listObservations.bind(store);
		store.listObservations = async (input) => {
			const observations = await listObservations(input);
			now = new Date("2026-07-26T12:00:01.000Z");
			return observations;
		};
		const reporting = createEngagementReporting({
			store,
			clock: () => now,
			nextId: () => "unused",
		});

		await expect(
			reporting.query({
				from: "2026-07-26T00:00:00.000Z",
				to: "2026-07-27T00:00:00.000Z",
			}),
		).resolves.toEqual({
			calculatedThrough: "2026-07-26T12:00:01.000Z",
			courses: [],
		});
	});

	it("supports reporting-disabled installations without changing callers", async () => {
		const reporting = createNullEngagementReporting();

		await expect(
			reporting.observe({
				type: "lesson_opened",
				courseId: "course-typescript",
				lessonId: "lesson-types",
			}),
		).resolves.toBeUndefined();
		await expect(
			reporting.query({
				from: "2026-07-26T00:00:00.000Z",
				to: "2026-07-27T00:00:00.000Z",
			}),
		).resolves.toEqual({
			calculatedThrough: null,
			courses: [],
		});
		await expect(reporting.pruneExpired()).resolves.toEqual({
			observationsPruned: 0,
		});
	});
});

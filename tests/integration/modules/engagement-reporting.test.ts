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

describe("Engagement Reporting", () => {
	it("separates directional anonymous opens from verified-account activity", async () => {
		const reporting = createEngagementReporting({
			store: createMemoryStore(),
			clock: () => new Date("2026-07-26T10:00:00.000Z"),
			nextId: (() => {
				let value = 0;
				return () => `observation-${++value}`;
			})(),
			pseudonymize: (learnerId, day) => `daily:${day}:${learnerId}`,
		});

		await reporting.observe({
			type: "course_opened",
			courseId: "course-typescript",
			actor: { kind: "anonymous" },
		});
		await reporting.observe({
			type: "course_opened",
			courseId: "course-typescript",
			actor: { kind: "verified", learnerId: "core-user-42" },
		});

		await expect(
			reporting.query({
				from: "2026-07-26T00:00:00.000Z",
				to: "2026-07-27T00:00:00.000Z",
				courseId: "course-typescript",
			}),
		).resolves.toEqual({
			calculatedThrough: "2026-07-26T10:00:00.000Z",
			courses: [
				{
					courseId: "course-typescript",
					opens: {
						total: 2,
						anonymous: 1,
						verified: 1,
					},
					verifiedAccountDays: 1,
					lessonOpens: { total: 0, anonymous: 0, verified: 0 },
					lessonCompletions: { total: 0, anonymous: 0, verified: 0 },
					checkOpens: { total: 0, anonymous: 0, verified: 0 },
					checkSubmissions: { total: 0, anonymous: 0, verified: 0 },
					passedSubmissions: { total: 0, anonymous: 0, verified: 0 },
				},
			],
		});
	});

	it("reports server-observed completions and coarse check-result bands without answers", async () => {
		const reporting = createEngagementReporting({
			store: createMemoryStore(),
			clock: () => new Date("2026-07-26T12:00:00.000Z"),
			nextId: (() => {
				let value = 0;
				return () => `observation-${++value}`;
			})(),
			pseudonymize: (learnerId, day) => `daily:${day}:${learnerId}`,
		});
		const verified = { kind: "verified", learnerId: "core-user-42" } as const;

		await reporting.observe({
			type: "lesson_opened",
			courseId: "course-typescript",
			lessonId: "lesson-types",
			actor: { kind: "anonymous" },
		});
		await reporting.observe({
			type: "lesson_completed",
			courseId: "course-typescript",
			lessonId: "lesson-types",
			actor: verified,
		});
		await reporting.observe({
			type: "check_opened",
			courseId: "course-typescript",
			checkId: "check-types",
			actor: { kind: "anonymous" },
		});
		await reporting.observe({
			type: "check_submitted",
			courseId: "course-typescript",
			checkId: "check-types",
			passed: true,
			score: 83,
			actor: verified,
		});
		await reporting.observe({
			type: "check_submitted",
			courseId: "course-typescript",
			checkId: "check-types",
			passed: false,
			score: 46,
			actor: verified,
		});
		await reporting.observe({
			type: "check_submitted",
			courseId: "course-typescript",
			checkId: "check-types",
			passed: true,
			score: 88,
			actor: { kind: "anonymous" },
		});

		const report = await reporting.query({
			from: "2026-07-26T00:00:00.000Z",
			to: "2026-07-27T00:00:00.000Z",
		});

		expect(report.courses[0]).toEqual({
			courseId: "course-typescript",
			opens: {
				total: 0,
				anonymous: 0,
				verified: 0,
			},
			verifiedAccountDays: 1,
			lessonOpens: { total: 1, anonymous: 1, verified: 0 },
			lessonCompletions: { total: 1, anonymous: 0, verified: 1 },
			checkOpens: { total: 1, anonymous: 1, verified: 0 },
			checkSubmissions: { total: 3, anonymous: 1, verified: 2 },
			passedSubmissions: { total: 2, anonymous: 1, verified: 1 },
			scoreBands: [
				{
					minimum: 40,
					maximum: 49,
					count: { total: 1, anonymous: 0, verified: 1 },
				},
				{
					minimum: 80,
					maximum: 89,
					count: { total: 2, anonymous: 1, verified: 1 },
				},
			],
		});
	});

	it("awaits keyed pseudonym generation before persisting verified activity", async () => {
		const store = createMemoryStore();
		const reporting = createEngagementReporting({
			store,
			clock: () => new Date("2026-07-26T12:00:00.000Z"),
			nextId: () => "observation-1",
			pseudonymize: async (learnerId, day) => `hmac:${day}:${learnerId}`,
		});

		await reporting.observe({
			type: "lesson_opened",
			courseId: "course-typescript",
			lessonId: "lesson-types",
			actor: { kind: "verified", learnerId: "core-user-42" },
		});

		expect(store.observations.get("observation-1")?.actorKey).toBe("hmac:2026-07-26:core-user-42");
	});

	it("finalizes a verified observation day after pseudonym generation crosses midnight", async () => {
		const store = createMemoryStore();
		let now = new Date("2026-07-26T23:59:59.999Z");
		const pseudonymDays: string[] = [];
		const reporting = createEngagementReporting({
			store,
			clock: () => now,
			nextId: () => "observation-1",
			async pseudonymize(learnerId, day) {
				pseudonymDays.push(day);
				now = new Date("2026-07-27T00:00:00.001Z");
				return `hmac:${day}:${learnerId}`;
			},
		});

		await reporting.observe({
			type: "course_opened",
			courseId: "course-typescript",
			actor: { kind: "verified", learnerId: "core-user-42" },
		});

		expect(pseudonymDays).toEqual(["2026-07-26", "2026-07-27"]);
		expect(store.observations.get("observation-1")).toMatchObject({
			observedAt: "2026-07-27T00:00:00.001Z",
			day: "2026-07-27",
			actorKey: "hmac:2026-07-27:core-user-42",
		});
	});

	it("prunes only observations strictly older than the fixed 90-day cutoff", async () => {
		const store = createMemoryStore();
		for (const observation of [
			{
				id: "expired",
				type: "course_opened",
				courseId: "course-typescript",
				actorKind: "anonymous",
				observedAt: "2026-04-27T11:59:59.999Z",
				day: "2026-04-27",
			},
			{
				id: "at-cutoff",
				type: "course_opened",
				courseId: "course-typescript",
				actorKind: "anonymous",
				observedAt: "2026-04-27T12:00:00.000Z",
				day: "2026-04-27",
			},
			{
				id: "retained",
				type: "course_opened",
				courseId: "course-typescript",
				actorKind: "anonymous",
				observedAt: "2026-07-26T12:00:00.000Z",
				day: "2026-07-26",
			},
		] satisfies StoredEngagementObservation[]) {
			store.observations.set(observation.id, observation);
		}
		const reporting = createEngagementReporting({
			store,
			clock: () => new Date("2026-07-26T12:00:00.000Z"),
			nextId: () => "unused",
			pseudonymize: () => "unused",
		});

		await expect(reporting.pruneExpired()).resolves.toEqual({
			observationsPruned: 1,
		});
		expect([...store.observations.keys()]).toEqual(["at-cutoff", "retained"]);
		await expect(reporting.pruneExpired()).resolves.toEqual({
			observationsPruned: 0,
		});
	});

	it("keeps exact raw observations as the only reporting source", async () => {
		const store = createMemoryStore();
		const reporting = createEngagementReporting({
			store,
			clock: () => new Date("2026-07-26T18:00:00.000Z"),
			nextId: (() => {
				let value = 0;
				return () => `observation-${++value}`;
			})(),
			pseudonymize: (learnerId, day) => `daily:${day}:${learnerId}`,
		});
		const verified = { kind: "verified", learnerId: "core-user-42" } as const;

		await reporting.observe({
			type: "course_opened",
			courseId: "course-typescript",
			actor: { kind: "anonymous" },
		});
		await reporting.observe({
			type: "course_opened",
			courseId: "course-typescript",
			actor: verified,
		});

		expect("compact" in reporting).toBe(false);
		expect(store.observations.size).toBe(2);
		await expect(
			reporting.query({
				from: "2026-07-26T00:00:00.000Z",
				to: "2026-07-27T00:00:00.000Z",
			}),
		).resolves.toEqual({
			calculatedThrough: "2026-07-26T18:00:00.000Z",
			courses: [
				{
					courseId: "course-typescript",
					opens: { total: 2, anonymous: 1, verified: 1 },
					verifiedAccountDays: 1,
					lessonOpens: { total: 0, anonymous: 0, verified: 0 },
					lessonCompletions: { total: 0, anonymous: 0, verified: 0 },
					checkOpens: { total: 0, anonymous: 0, verified: 0 },
					checkSubmissions: { total: 0, anonymous: 0, verified: 0 },
					passedSubmissions: { total: 0, anonymous: 0, verified: 0 },
				},
			],
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
			pseudonymize: () => "unused",
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

	it("supports privacy-disabled installations without changing learning callers", async () => {
		const reporting = createNullEngagementReporting();

		await expect(
			reporting.observe({
				type: "lesson_completed",
				courseId: "course-typescript",
				lessonId: "lesson-types",
				actor: { kind: "verified", learnerId: "core-user-42" },
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

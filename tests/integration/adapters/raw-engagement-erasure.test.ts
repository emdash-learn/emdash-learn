import { describe, expect, it, vi } from "vitest";

import { createRawEngagementErasureAdapter } from "../../../src/adapters/raw-engagement-erasure.js";
import type { StoredEngagementObservation } from "../../../src/modules/engagement-reporting/index.js";
import { createMemoryStorageCollection } from "../../utils/memory-storage.js";

function observation(id: string, day: string, actorKey: string): StoredEngagementObservation {
	return {
		id,
		type: "course_opened",
		courseId: "course-1",
		actorKind: "verified",
		actorKey,
		observedAt: `${day}T12:00:00.000Z`,
		day,
	};
}

describe("raw engagement erasure adapter", () => {
	it("deletes only daily pseudonyms belonging to the verified learner", async () => {
		const rows = createMemoryStorageCollection<StoredEngagementObservation>();
		await rows.put("mine-day-1", observation("mine-day-1", "2026-07-24", "mine:2026-07-24"));
		await rows.put("mine-day-2", observation("mine-day-2", "2026-07-25", "mine:2026-07-25"));
		await rows.put("other", observation("other", "2026-07-25", "other:2026-07-25"));
		await rows.put("anonymous", {
			...observation("anonymous", "2026-07-25", ""),
			actorKind: "anonymous",
			actorKey: undefined,
		});
		const erasure = createRawEngagementErasureAdapter({
			observations: rows,
			pseudonymize: (learnerId, day) =>
				learnerId === "learner-mine" ? `mine:${day}` : `other:${day}`,
			clock: () => new Date("2026-07-26T12:00:00.000Z"),
			pruneExpiredBefore: async () => 0,
		});

		await expect(erasure.erase({ kind: "verified", learnerId: "learner-mine" })).resolves.toBe(2);
		expect(new Set(rows.documents.keys())).toEqual(new Set(["anonymous", "other"]));
	});

	it("is idempotent when no attributable raw observations remain", async () => {
		const rows = createMemoryStorageCollection<StoredEngagementObservation>();
		const erasure = createRawEngagementErasureAdapter({
			observations: rows,
			pseudonymize: (_learnerId, day) => `mine:${day}`,
			clock: () => new Date("2026-07-26T12:00:00.000Z"),
			pruneExpiredBefore: async () => 0,
		});
		const learner = { kind: "verified" as const, learnerId: "learner-mine" };

		await expect(erasure.erase(learner)).resolves.toBe(0);
		await expect(erasure.erase(learner)).resolves.toBe(0);
	});

	it("prunes first and queries only indexed daily pseudonyms regardless of unrelated volume", async () => {
		const rows = createMemoryStorageCollection<StoredEngagementObservation>();
		await rows.putMany([
			...Array.from({ length: 205 }, (_, index) => ({
				id: `mine-${index}`,
				data: observation(`mine-${index}`, "2026-07-25", "mine:2026-07-25"),
			})),
			...Array.from({ length: 250 }, (_, index) => ({
				id: `other-${index}`,
				data: observation(`other-${index}`, "2026-07-25", `other-${index}:2026-07-25`),
			})),
		]);
		const query = vi.spyOn(rows, "query");
		const deleteMany = vi.spyOn(rows, "deleteMany");
		const pruneExpiredBefore = vi.fn(async () => 0);
		const erasure = createRawEngagementErasureAdapter({
			observations: rows,
			pseudonymize: (_learnerId, day) => `mine:${day}`,
			clock: () => new Date("2026-07-26T12:00:00.000Z"),
			pruneExpiredBefore,
		});

		await expect(erasure.erase({ kind: "verified", learnerId: "learner-mine" })).resolves.toBe(205);

		expect(pruneExpiredBefore).toHaveBeenCalledWith("2026-04-27T12:00:00.000Z");
		expect(query).toHaveBeenCalledTimes(3);
		for (const [options] of query.mock.calls) {
			expect(options?.where).toEqual({
				actorKey: {
					in: expect.arrayContaining(["mine:2026-04-27", "mine:2026-07-26"]),
				},
			});
			expect(Reflect.get(Reflect.get(options?.where, "actorKey") ?? {}, "in")).toHaveLength(91);
		}
		expect(deleteMany).toHaveBeenCalledTimes(3);
		expect(deleteMany.mock.calls.every(([ids]) => ids.length <= 100)).toBe(true);
		expect(rows.documents.size).toBe(250);
	});

	it("fails the category before any learner query when strict retention pruning fails", async () => {
		const rows = createMemoryStorageCollection<StoredEngagementObservation>();
		const query = vi.spyOn(rows, "query");
		const erasure = createRawEngagementErasureAdapter({
			observations: rows,
			pseudonymize: (_learnerId, day) => `mine:${day}`,
			clock: () => new Date("2026-07-26T12:00:00.000Z"),
			async pruneExpiredBefore() {
				throw new Error("retention unavailable");
			},
		});

		await expect(erasure.erase({ kind: "verified", learnerId: "learner-mine" })).rejects.toThrow(
			"retention unavailable",
		);
		expect(query).not.toHaveBeenCalled();
	});
});

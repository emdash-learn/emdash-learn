import { describe, expect, it } from "vitest";

import {
	createEngagementStoreAdapter,
	type EngagementObservationCollection,
} from "../../../src/adapters/engagement-store.js";
import type { StoredEngagementObservation } from "../../../src/modules/engagement-reporting/index.js";

function matches(value: unknown, filter: unknown): boolean {
	if (typeof filter !== "object" || filter === null) return value === filter;
	const gte = Reflect.get(filter, "gte");
	const lt = Reflect.get(filter, "lt");
	return (
		(gte === undefined || (typeof value === "string" && value >= gte)) &&
		(lt === undefined || (typeof value === "string" && value < lt))
	);
}

function createCollection<T extends object>(): {
	documents: Map<string, T>;
	put(id: string, data: T): Promise<void>;
	deleteMany(ids: string[]): Promise<number>;
	query(options?: { where?: Record<string, unknown>; cursor?: string }): Promise<{
		items: Array<{ id: string; data: T }>;
		cursor?: string;
		hasMore: boolean;
	}>;
} {
	const documents = new Map<string, T>();
	return {
		documents,
		async put(id, data) {
			documents.set(id, structuredClone(data));
		},
		async deleteMany(ids) {
			let deleted = 0;
			for (const id of ids) {
				if (documents.delete(id)) deleted += 1;
			}
			return deleted;
		},
		async query(options) {
			const where = options?.where ?? {};
			const offset = Number(options?.cursor ?? "0");
			const matchesWhere = [...documents.entries()].filter(([, data]) =>
				Object.entries(where).every(([field, filter]) => matches(Reflect.get(data, field), filter)),
			);
			const pageSize = 1;
			const items = matchesWhere.slice(offset, offset + pageSize).map(([id, data]) => ({
				id,
				data: structuredClone(data),
			}));
			const nextOffset = offset + items.length;
			return {
				items,
				hasMore: nextOffset < matchesWhere.length,
				...(nextOffset < matchesWhere.length ? { cursor: String(nextOffset) } : {}),
			};
		},
	};
}

describe("engagement storage adapter", () => {
	it("paginates raw ranges and deletes only observations strictly before a cutoff", async () => {
		const observations = createCollection<StoredEngagementObservation>();
		const store = createEngagementStoreAdapter(
			observations satisfies EngagementObservationCollection,
		);
		/* oxlint-disable no-await-in-loop -- deterministic fixture writes preserve insertion order */
		for (const observation of [
			{
				id: "observation-1",
				type: "course_opened",
				courseId: "course-typescript",
				actorKind: "anonymous",
				observedAt: "2026-07-25T23:59:00.000Z",
				day: "2026-07-25",
			},
			{
				id: "observation-2",
				type: "lesson_opened",
				courseId: "course-typescript",
				lessonId: "lesson-types",
				actorKind: "verified",
				actorKey: "daily-key",
				observedAt: "2026-07-26T10:00:00.000Z",
				day: "2026-07-26",
			},
			{
				id: "observation-3",
				type: "course_opened",
				courseId: "course-css",
				actorKind: "anonymous",
				observedAt: "2026-07-26T11:00:00.000Z",
				day: "2026-07-26",
			},
		] satisfies StoredEngagementObservation[]) {
			await store.appendObservation(observation);
		}
		/* oxlint-enable no-await-in-loop */

		await expect(
			store.listObservations({
				from: "2026-07-26T00:00:00.000Z",
				to: "2026-07-27T00:00:00.000Z",
			}),
		).resolves.toHaveLength(2);
		await expect(store.deleteObservationsBefore("2026-07-26T10:00:00.000Z")).resolves.toBe(1);
		expect([...observations.documents.keys()]).toEqual(["observation-2", "observation-3"]);
	});
});

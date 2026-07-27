import { describe, expect, it, vi } from "vitest";

import {
	createCompletionFactStoreAdapter,
	type CompletionFactCollection,
} from "../../../src/adapters/completion-fact-store.js";
import type { CompletionFact } from "../../../src/modules/learning-record/index.js";

function createCollection(
	collectionOptions: { raceFirstCompoundLookups?: boolean } = {},
): CompletionFactCollection & {
	documents: Map<string, CompletionFact>;
} {
	const documents = new Map<string, CompletionFact>();
	let gatedLookups = 0;
	let releaseLookupGate: (() => void) | undefined;
	const lookupGate = new Promise<void>((resolve) => {
		releaseLookupGate = resolve;
	});
	return {
		documents,
		async put(id, fact) {
			const conflict = [...documents.entries()].some(
				([existingId, existing]) =>
					existingId !== id &&
					existing.learnerKey === fact.learnerKey &&
					existing.lessonId === fact.lessonId,
			);
			if (conflict) {
				throw new Error("UNIQUE constraint failed: learnerKey, lessonId");
			}
			documents.set(id, structuredClone(fact));
		},
		async deleteMany(ids) {
			let deleted = 0;
			for (const id of ids) {
				if (!documents.delete(id)) continue;
				deleted += 1;
			}
			return deleted;
		},
		async query(queryOptions) {
			const where = queryOptions?.where ?? {};
			const offset = Number(queryOptions?.cursor ?? "0");
			const matches = [...documents.entries()].filter(([, fact]) =>
				Object.entries(where).every(([field, value]) => Reflect.get(fact, field) === value),
			);
			if (
				collectionOptions.raceFirstCompoundLookups === true &&
				"learnerKey" in where &&
				"lessonId" in where &&
				gatedLookups < 2
			) {
				gatedLookups += 1;
				if (gatedLookups === 2) releaseLookupGate?.();
				await lookupGate;
			}
			const pageSize = 1;
			const items = matches.slice(offset, offset + pageSize).map(([id, data]) => ({
				id,
				data: structuredClone(data),
			}));
			const nextOffset = offset + items.length;
			return {
				items,
				hasMore: nextOffset < matches.length,
				...(nextOffset < matches.length ? { cursor: String(nextOffset) } : {}),
			};
		},
	};
}

function createStore(collection: CompletionFactCollection) {
	let nextId = 0;
	return createCompletionFactStoreAdapter(collection, {
		nextId: () => `completion_${String(nextId++)}`,
	});
}

describe("completion fact storage adapter", () => {
	it("creates an immutable fact and returns the durable winner on retry", async () => {
		const collection = createCollection();
		const store = createStore(collection);
		const first: CompletionFact = {
			learnerKey: "installation-keyed-owner",
			courseId: "course-typescript",
			lessonId: "lesson-types",
			completedAt: "2026-07-26T15:00:00.000Z",
			source: "learner",
			operationId: "4c02bb57-8192-46ef-81ac-a71f8db4ea62",
		};
		const retry: CompletionFact = {
			...first,
			completedAt: "2026-07-26T15:01:00.000Z",
			source: "device_import",
			operationId: "cff93d77-83f0-48f6-a108-97c58ed42616",
		};

		await expect(store.create(first)).resolves.toEqual({
			created: true,
			fact: first,
		});
		await expect(store.create(first)).resolves.toEqual({
			created: false,
			fact: first,
		});
		await expect(store.create(retry)).resolves.toEqual({
			created: false,
			fact: first,
		});
	});

	it("converges simultaneous retries with the same operation id on the first durable fact", async () => {
		const collection = createCollection({ raceFirstCompoundLookups: true });
		const store = createStore(collection);
		const first: CompletionFact = {
			learnerKey: "installation-keyed-owner",
			courseId: "course-typescript",
			lessonId: "lesson-types",
			completedAt: "2026-07-26T15:00:00.000Z",
			source: "learner",
			operationId: "4c02bb57-8192-46ef-81ac-a71f8db4ea62",
		};
		const second: CompletionFact = {
			...first,
			completedAt: "2026-07-26T15:01:00.000Z",
			source: "device_import",
		};

		const results = await Promise.all([store.create(first), store.create(second)]);

		expect(results.filter(({ created }) => created)).toHaveLength(1);
		expect(results.filter(({ created }) => !created)).toHaveLength(1);
		expect(results[0]?.fact).toEqual(results[1]?.fact);
		expect([first, second]).toContainEqual(results[0]?.fact);
		expect([...collection.documents.values()]).toEqual([results[0]?.fact]);
	});

	it("rethrows a failed create when no concurrent winner is durable", async () => {
		const collection = createCollection();
		const storageFailure = new Error("storage unavailable");
		collection.put = async () => {
			throw storageFailure;
		};
		const store = createStore(collection);
		const fact: CompletionFact = {
			learnerKey: "installation-keyed-owner",
			courseId: "course-typescript",
			lessonId: "lesson-types",
			completedAt: "2026-07-26T15:00:00.000Z",
			source: "learner",
			operationId: "4c02bb57-8192-46ef-81ac-a71f8db4ea62",
		};

		await expect(store.create(fact)).rejects.toBe(storageFailure);
	});

	it("uses a fresh server-generated row id and reads by the unique lesson key", async () => {
		const collection = createCollection();
		const nextId = "completion_4c02bb57819246ef81aca71f8db4ea62";
		const store = createCompletionFactStoreAdapter(collection, {
			nextId: () => nextId,
		});
		const fact: CompletionFact = {
			learnerKey: "learner-key:a",
			courseId: "course-typescript",
			lessonId: "lesson:b",
			completedAt: "2026-07-26T15:00:00.000Z",
			source: "learner",
			operationId: "4c02bb57-8192-46ef-81ac-a71f8db4ea62",
		};

		await store.create(fact);

		expect([...collection.documents.keys()]).toEqual([nextId]);
		expect(nextId).not.toContain("learner-key:a");
		expect(nextId).not.toContain("lesson:b");
		expect(nextId).not.toContain("4c02bb57-8192-46ef-81ac-a71f8db4ea62");
		await expect(store.get("learner-key:a", "lesson:b")).resolves.toEqual(fact);
	});

	it("paginates indexed owner queries and erases no other learner", async () => {
		const collection = createCollection();
		const store = createStore(collection);
		const facts = [
			{
				learnerKey: "learner-key-a",
				courseId: "course-typescript",
				lessonId: "lesson-types",
				completedAt: "2026-07-26T15:00:00.000Z",
				source: "learner",
				operationId: "complete-a-1",
			},
			{
				learnerKey: "learner-key-a",
				courseId: "course-typescript",
				lessonId: "lesson-narrowing",
				completedAt: "2026-07-26T15:01:00.000Z",
				source: "device_import",
				operationId: "complete-a-2",
			},
			{
				learnerKey: "learner-key-b",
				courseId: "course-typescript",
				lessonId: "lesson-types",
				completedAt: "2026-07-26T15:02:00.000Z",
				source: "learner",
				operationId: "complete-b-1",
			},
		] satisfies CompletionFact[];
		await Promise.all(facts.map(async (fact) => store.create(fact)));

		await expect(
			store.listForLessons("learner-key-a", ["lesson-types", "lesson-narrowing"]),
		).resolves.toHaveLength(2);
		await expect(store.deleteForLearner("learner-key-a")).resolves.toBe(2);
		await expect(
			store.listForLessons("learner-key-a", ["lesson-types", "lesson-narrowing"]),
		).resolves.toEqual([]);
		await expect(
			store.listForLessons("learner-key-b", ["lesson-types", "lesson-narrowing"]),
		).resolves.toHaveLength(1);
	});

	it("rechecks ownership when storage returns a mismatched row", async () => {
		const collection = createCollection();
		collection.documents.set("mine", {
			learnerKey: "learner-key-a",
			courseId: "course-typescript",
			lessonId: "lesson-a",
			completedAt: "2026-07-26T15:00:00.000Z",
			source: "learner",
			operationId: "complete-a",
		});
		collection.documents.set("other", {
			learnerKey: "learner-key-b",
			courseId: "course-typescript",
			lessonId: "lesson-b",
			completedAt: "2026-07-26T15:00:00.000Z",
			source: "learner",
			operationId: "complete-b",
		});
		collection.query = async () => ({
			items: [...collection.documents.entries()].map(([id, data]) => ({
				id,
				data: structuredClone(data),
			})),
			hasMore: false,
		});
		const store = createStore(collection);

		await expect(store.deleteForLearner("learner-key-a")).resolves.toBe(1);
		expect([...collection.documents.keys()]).toEqual(["other"]);
	});

	it("erases scale-shaped completion history in bounded batches", async () => {
		const collection = createCollection();
		for (let index = 0; index < 205; index += 1) {
			collection.documents.set(`mine-${index}`, {
				learnerKey: "learner-key-a",
				courseId: "course-typescript",
				lessonId: `lesson-mine-${index}`,
				completedAt: "2026-07-26T15:00:00.000Z",
				source: "learner",
				operationId: `complete-mine-${index}`,
			});
		}
		for (let index = 0; index < 15; index += 1) {
			collection.documents.set(`other-${index}`, {
				learnerKey: "learner-key-b",
				courseId: "course-typescript",
				lessonId: `lesson-other-${index}`,
				completedAt: "2026-07-26T15:00:00.000Z",
				source: "learner",
				operationId: `complete-other-${index}`,
			});
		}
		const deleteMany = vi.spyOn(collection, "deleteMany");
		const store = createStore(collection);

		await expect(store.deleteForLearner("learner-key-a")).resolves.toBe(205);
		await expect(store.deleteForLearner("learner-key-a")).resolves.toBe(0);

		expect(deleteMany).toHaveBeenCalledTimes(3);
		expect(deleteMany.mock.calls.every(([ids]) => ids.length <= 100)).toBe(true);
		expect(collection.documents.size).toBe(15);
		expect(
			[...collection.documents.values()].every(({ learnerKey }) => learnerKey === "learner-key-b"),
		).toBe(true);
	});
});

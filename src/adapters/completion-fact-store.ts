import type { StorageCollection } from "emdash";

import type { CompletionFact, CompletionFactStore } from "../modules/learning-record/index.js";

export type CompletionFactCollection = Pick<
	StorageCollection<CompletionFact>,
	"put" | "query" | "deleteMany"
>;

export interface CompletionFactStoreAdapterDependencies {
	/** Returns a fresh, server-generated storage row id for each insert attempt. */
	nextId(): string;
}

const DELETE_BATCH_SIZE = 100;

function isCompletionFact(value: unknown): value is CompletionFact {
	if (typeof value !== "object" || value === null) return false;
	return (
		typeof Reflect.get(value, "learnerKey") === "string" &&
		typeof Reflect.get(value, "courseId") === "string" &&
		typeof Reflect.get(value, "lessonId") === "string" &&
		typeof Reflect.get(value, "completedAt") === "string" &&
		(Reflect.get(value, "source") === "learner" ||
			Reflect.get(value, "source") === "device_import") &&
		typeof Reflect.get(value, "operationId") === "string"
	);
}

async function queryAll(
	collection: CompletionFactCollection,
	where: Record<string, string>,
): Promise<Array<{ id: string; data: CompletionFact }>> {
	const rows: Array<{ id: string; data: CompletionFact }> = [];
	let cursor: string | undefined;
	do {
		// oxlint-disable-next-line no-await-in-loop -- storage pagination is sequential by contract
		const page = await collection.query({
			where,
			limit: 1000,
			...(cursor === undefined ? {} : { cursor }),
		});
		for (const row of page.items) {
			if (isCompletionFact(row.data)) rows.push(row);
		}
		if (page.hasMore && page.cursor === undefined) {
			throw new Error("Completion storage returned a paginated page without a cursor.");
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor !== undefined);
	return rows;
}

async function findCompletionFact(
	collection: CompletionFactCollection,
	learnerKey: string,
	lessonId: string,
): Promise<CompletionFact | null> {
	const rows = await queryAll(collection, { learnerKey, lessonId });
	return (
		rows
			.map(({ data }) => data)
			.find((fact) => fact.learnerKey === learnerKey && fact.lessonId === lessonId) ?? null
	);
}

export function createCompletionFactStoreAdapter(
	collection: CompletionFactCollection,
	dependencies: CompletionFactStoreAdapterDependencies,
): CompletionFactStore {
	return {
		async get(learnerKey, lessonId) {
			return findCompletionFact(collection, learnerKey, lessonId);
		},
		async create(fact) {
			const existing = await findCompletionFact(collection, fact.learnerKey, fact.lessonId);
			if (existing) {
				return { created: false, fact: existing };
			}
			try {
				// A fresh row id makes the compound unique index arbitrate simultaneous
				// retries instead of turning put() into a same-id overwrite.
				await collection.put(dependencies.nextId(), fact);
				return { created: true, fact };
			} catch (error) {
				const winner = await findCompletionFact(collection, fact.learnerKey, fact.lessonId);
				if (winner) return { created: false, fact: winner };
				throw error;
			}
		},
		async listForLessons(learnerKey, lessonIds) {
			const currentLessons = new Set(lessonIds);
			const rows = await queryAll(collection, { learnerKey });
			return rows
				.map(({ data }) => data)
				.filter((fact) => fact.learnerKey === learnerKey && currentLessons.has(fact.lessonId));
		},
		async deleteForLearner(learnerKey) {
			const rows = await queryAll(collection, { learnerKey });
			const ids = rows.filter(({ data }) => data.learnerKey === learnerKey).map(({ id }) => id);
			let deleted = 0;
			for (let offset = 0; offset < ids.length; offset += DELETE_BATCH_SIZE) {
				// oxlint-disable-next-line no-await-in-loop -- bound each storage deletion batch
				deleted += await collection.deleteMany(ids.slice(offset, offset + DELETE_BATCH_SIZE));
			}
			return deleted;
		},
	};
}

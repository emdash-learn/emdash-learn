import type { StorageCollection } from "emdash";

import type {
	EngagementStore,
	StoredEngagementObservation,
} from "../modules/engagement-reporting/index.js";

export type EngagementObservationCollection = Pick<
	StorageCollection<StoredEngagementObservation>,
	"put" | "query" | "deleteMany"
>;

type StorageQuery = NonNullable<Parameters<EngagementObservationCollection["query"]>[0]>;
type StorageWhere = NonNullable<StorageQuery["where"]>;

const OBSERVATION_TYPES = new Set([
	"course_opened",
	"lesson_opened",
	"check_opened",
	"check_submitted",
]);
const DELETE_BATCH_SIZE = 100;

function isStoredObservation(value: unknown): value is StoredEngagementObservation {
	if (typeof value !== "object" || value === null) return false;
	return (
		typeof Reflect.get(value, "id") === "string" &&
		OBSERVATION_TYPES.has(String(Reflect.get(value, "type"))) &&
		typeof Reflect.get(value, "courseId") === "string" &&
		typeof Reflect.get(value, "observedAt") === "string" &&
		typeof Reflect.get(value, "day") === "string"
	);
}

async function allObservationRows(
	collection: EngagementObservationCollection,
	where: StorageWhere,
): Promise<Array<{ id: string; data: StoredEngagementObservation }>> {
	const rows: Array<{ id: string; data: StoredEngagementObservation }> = [];
	let cursor: string | undefined;
	do {
		// oxlint-disable-next-line no-await-in-loop -- storage pagination is sequential by contract
		const page = await collection.query({
			where,
			limit: 1000,
			...(cursor === undefined ? {} : { cursor }),
		});
		rows.push(...page.items);
		if (page.hasMore && page.cursor === undefined) {
			throw new Error("Engagement storage returned a paginated page without a cursor.");
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor !== undefined);
	return rows;
}

export function createEngagementStoreAdapter(
	observations: EngagementObservationCollection,
): EngagementStore {
	return {
		async appendObservation(observation) {
			await observations.put(observation.id, observation);
		},
		async listObservations(input) {
			const rows = await allObservationRows(observations, {
				observedAt: { gte: input.from, lt: input.to },
			});
			return rows
				.map(({ data }) => data)
				.filter(
					(observation) =>
						isStoredObservation(observation) &&
						observation.observedAt >= input.from &&
						observation.observedAt < input.to,
				);
		},
		async deleteObservationsBefore(cutoff) {
			const rows = await allObservationRows(observations, {
				observedAt: { lt: cutoff },
			});
			const ids = rows
				.filter(({ data }) => isStoredObservation(data) && data.observedAt < cutoff)
				.map(({ id }) => id);
			let deleted = 0;
			for (let offset = 0; offset < ids.length; offset += DELETE_BATCH_SIZE) {
				// oxlint-disable-next-line no-await-in-loop -- bound each storage deletion batch
				deleted += await observations.deleteMany(ids.slice(offset, offset + DELETE_BATCH_SIZE));
			}
			return deleted;
		},
	};
}

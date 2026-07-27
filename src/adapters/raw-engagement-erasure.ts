import type { StorageCollection } from "emdash";

import {
	ENGAGEMENT_OBSERVATION_RETENTION_DAYS,
	type StoredEngagementObservation,
} from "../modules/engagement-reporting/index.js";
import type { LearnerDataErasurePort } from "../modules/privacy-erasure.js";

type ObservationCollection = Pick<
	StorageCollection<StoredEngagementObservation>,
	"query" | "deleteMany"
>;

export interface RawEngagementErasureAdapterOptions {
	observations: ObservationCollection;
	pseudonymize(learnerId: string, day: string): string | Promise<string>;
	clock(): Date;
	pruneExpiredBefore(cutoff: string): Promise<number>;
}

const DAY_MS = 86_400_000;
const DELETE_BATCH_SIZE = 100;

function utcDay(value: Date): string {
	return value.toISOString().slice(0, 10);
}

function retainedUtcDays(cutoff: Date, now: Date): string[] {
	const first = Date.parse(`${utcDay(cutoff)}T00:00:00.000Z`);
	const last = Date.parse(`${utcDay(now)}T00:00:00.000Z`);
	const days: string[] = [];
	for (let instant = first; instant <= last; instant += DAY_MS) {
		days.push(new Date(instant).toISOString().slice(0, 10));
	}
	return days;
}

async function matchingObservationIds(
	observations: ObservationCollection,
	actorKeys: string[],
): Promise<string[]> {
	const matchingIds: string[] = [];
	const attributableKeys = new Set(actorKeys);
	const seenCursors = new Set<string>();
	let cursor: string | undefined;

	do {
		// oxlint-disable-next-line no-await-in-loop -- storage pagination is sequential
		const page = await observations.query({
			where: { actorKey: { in: actorKeys } },
			limit: 100,
			cursor,
		});
		for (const row of page.items) {
			if (
				row.data.actorKind === "verified" &&
				row.data.actorKey !== undefined &&
				attributableKeys.has(row.data.actorKey)
			) {
				matchingIds.push(row.id);
			}
		}

		if (!page.hasMore) {
			cursor = undefined;
			continue;
		}
		if (!page.cursor || seenCursors.has(page.cursor)) {
			throw new Error("Raw engagement erasure could not continue deterministic pagination.");
		}
		seenCursors.add(page.cursor);
		cursor = page.cursor;
	} while (cursor);

	return matchingIds;
}

/**
 * Erase attributable observations without introducing a stable reporting
 * identifier. Expired rows are pruned first; the adapter then recomputes the
 * learner's pseudonym for every UTC day intersecting the retained window and
 * resolves those day-scoped values through one indexed `actorKey IN (...)`
 * query.
 */
export function createRawEngagementErasureAdapter(
	options: RawEngagementErasureAdapterOptions,
): LearnerDataErasurePort {
	return {
		async erase(learner) {
			const now = options.clock();
			const cutoff = new Date(now.valueOf() - ENGAGEMENT_OBSERVATION_RETENTION_DAYS * DAY_MS);
			await options.pruneExpiredBefore(cutoff.toISOString());

			const days = retainedUtcDays(cutoff, now);
			const actorKeys = await Promise.all(
				days.map((day) => Promise.resolve(options.pseudonymize(learner.learnerId, day))),
			);
			const matchingIds = await matchingObservationIds(options.observations, actorKeys);

			let deleted = 0;
			for (let offset = 0; offset < matchingIds.length; offset += DELETE_BATCH_SIZE) {
				// oxlint-disable-next-line no-await-in-loop -- bound each storage deletion batch
				deleted += await options.observations.deleteMany(
					matchingIds.slice(offset, offset + DELETE_BATCH_SIZE),
				);
			}
			return deleted;
		},
	};
}

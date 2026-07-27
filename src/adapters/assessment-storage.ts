import type { StorageCollection } from "emdash";

import type {
	AssessmentAttemptRecord,
	AssessmentRevisionRecord,
	AssessmentStorage,
	DraftCheck,
} from "../modules/assessment/index.js";

export interface AssessmentHeadRecord {
	checkId: string;
	revisionId: string;
}

export type AssessmentDraftCollection = Pick<
	StorageCollection<DraftCheck>,
	"get" | "put" | "delete" | "query"
>;
export type AssessmentRevisionCollection = Pick<
	StorageCollection<AssessmentRevisionRecord>,
	"get" | "put"
>;
export type AssessmentHeadCollection = Pick<
	StorageCollection<AssessmentHeadRecord>,
	"get" | "put" | "delete"
>;
export type AssessmentAttemptCollection = Pick<
	StorageCollection<AssessmentAttemptRecord>,
	"get" | "put" | "query" | "deleteMany"
>;

export interface AssessmentStorageCollections {
	drafts: AssessmentDraftCollection;
	revisions: AssessmentRevisionCollection;
	heads: AssessmentHeadCollection;
	attempts: AssessmentAttemptCollection;
}

type DraftQuery = NonNullable<Parameters<AssessmentDraftCollection["query"]>[0]>;
type AttemptQuery = NonNullable<Parameters<AssessmentAttemptCollection["query"]>[0]>;
const DELETE_BATCH_SIZE = 100;

async function listAllDrafts(collection: AssessmentDraftCollection): Promise<DraftCheck[]> {
	const drafts: DraftCheck[] = [];
	let cursor: string | undefined;
	do {
		// oxlint-disable-next-line no-await-in-loop -- storage pagination is sequential by contract
		const page = await collection.query({
			limit: 1000,
			...(cursor === undefined ? {} : { cursor }),
		} satisfies DraftQuery);
		drafts.push(...page.items.map(({ data }) => data));
		if (page.hasMore && page.cursor === undefined) {
			throw new Error("Assessment draft storage returned a page without a cursor.");
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor !== undefined);
	return drafts;
}

async function listAttemptRows(
	collection: AssessmentAttemptCollection,
	learnerKey: string,
): Promise<Array<{ id: string; data: AssessmentAttemptRecord }>> {
	const attempts: Array<{ id: string; data: AssessmentAttemptRecord }> = [];
	let cursor: string | undefined;
	do {
		// oxlint-disable-next-line no-await-in-loop -- storage pagination is sequential by contract
		const page = await collection.query({
			where: { learnerKey },
			limit: 1000,
			...(cursor === undefined ? {} : { cursor }),
		} satisfies AttemptQuery);
		attempts.push(...page.items.filter(({ data }) => data.learnerKey === learnerKey));
		if (page.hasMore && page.cursor === undefined) {
			throw new Error("Assessment attempt storage returned a page without a cursor.");
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor !== undefined);
	return attempts;
}

async function findAttempt(
	collection: AssessmentAttemptCollection,
	learnerKey: string,
	submissionId: string,
): Promise<AssessmentAttemptRecord | undefined> {
	const page = await collection.query({
		where: { learnerKey, submissionId },
		limit: 2,
	} satisfies AttemptQuery);
	const matches = page.items.filter(
		({ data }) => data.learnerKey === learnerKey && data.submissionId === submissionId,
	);
	if (matches.length > 1 || page.hasMore) {
		throw new Error(
			"Assessment Attempt uniqueness invariant was violated for a learner submission id.",
		);
	}
	return matches[0]?.data;
}

export function createAssessmentStorageAdapter(
	collections: AssessmentStorageCollections,
): AssessmentStorage {
	return {
		async getDraft(checkId) {
			return (await collections.drafts.get(checkId)) ?? undefined;
		},
		async putDraft(draft) {
			await collections.drafts.put(draft.checkId, draft);
		},
		async deleteDraft(checkId) {
			await collections.drafts.delete(checkId);
		},
		async listDrafts() {
			return listAllDrafts(collections.drafts);
		},
		async getRevision(revisionId) {
			return (await collections.revisions.get(revisionId)) ?? undefined;
		},
		async createRevision(revision) {
			if (await collections.revisions.get(revision.revisionId)) {
				throw new Error(`Revision "${revision.revisionId}" already exists.`);
			}
			await collections.revisions.put(revision.revisionId, revision);
		},
		async getHead(checkId) {
			const head = await collections.heads.get(checkId);
			return head?.checkId === checkId ? head.revisionId : undefined;
		},
		async setHead(checkId, revisionId) {
			await collections.heads.put(checkId, { checkId, revisionId });
		},
		async archiveHead(checkId) {
			return collections.heads.delete(checkId);
		},
		async getAttempt(learnerKey, submissionId) {
			return findAttempt(collections.attempts, learnerKey, submissionId);
		},
		async createAttempt(attemptId, attempt) {
			try {
				await collections.attempts.put(attemptId, attempt);
				return "created";
			} catch (error) {
				// A unique `(learnerKey, submissionId)` violation is the expected
				// loser path in a concurrent race. Only suppress the write error
				// after the durable winner is observable; unrelated failures pass on.
				if (await findAttempt(collections.attempts, attempt.learnerKey, attempt.submissionId)) {
					return "duplicate";
				}
				throw error;
			}
		},
		async listAttempts(learnerKey) {
			return (await listAttemptRows(collections.attempts, learnerKey)).map(({ data }) => data);
		},
		async eraseLearnerAttempts(learnerKey) {
			const rows = await listAttemptRows(collections.attempts, learnerKey);
			const ids = rows.map(({ id }) => id);
			let deleted = 0;
			for (let offset = 0; offset < ids.length; offset += DELETE_BATCH_SIZE) {
				// oxlint-disable-next-line no-await-in-loop -- bound each storage deletion batch
				deleted += await collections.attempts.deleteMany(
					ids.slice(offset, offset + DELETE_BATCH_SIZE),
				);
			}
			return deleted;
		},
	};
}

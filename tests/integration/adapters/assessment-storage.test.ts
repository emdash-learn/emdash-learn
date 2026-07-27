import { describe, expect, it, vi } from "vitest";

import {
	createAssessmentStorageAdapter,
	type AssessmentAttemptCollection,
	type AssessmentDraftCollection,
	type AssessmentHeadCollection,
	type AssessmentRevisionCollection,
} from "../../../src/adapters/assessment-storage.js";
import type {
	AssessmentAttemptRecord,
	AssessmentRevisionRecord,
	DraftCheck,
} from "../../../src/modules/assessment/index.js";

function createCollection<T extends object>() {
	const documents = new Map<string, T>();
	return {
		documents,
		async get(id: string) {
			return documents.get(id) ?? null;
		},
		async put(id: string, data: T) {
			documents.set(id, structuredClone(data));
		},
		async delete(id: string) {
			return documents.delete(id);
		},
		async deleteMany(ids: string[]) {
			let deleted = 0;
			for (const id of ids) {
				if (documents.delete(id)) deleted += 1;
			}
			return deleted;
		},
		async query(options: { where?: Record<string, unknown>; cursor?: string } = {}) {
			const offset = Number(options.cursor ?? "0");
			const matches = [...documents.entries()].filter(([, data]) =>
				Object.entries(options.where ?? {}).every(
					([field, value]) => Reflect.get(data, field) === value,
				),
			);
			const items = matches.slice(offset, offset + 1).map(([id, data]) => ({
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

function draft(checkId: string): DraftCheck {
	return {
		checkId,
		courseId: "course-1",
		title: `Check ${checkId}`,
		passingScore: 70,
		questions: [],
		createdAt: "2026-07-26T10:00:00.000Z",
		updatedAt: "2026-07-26T10:00:00.000Z",
	};
}

function attempt(learnerKey: string, attemptId: string): AssessmentAttemptRecord {
	return {
		learnerKey,
		submissionId: `submission-${attemptId}`,
		courseId: "course-1",
		fingerprint: `fingerprint-${attemptId}`,
		result: {
			courseId: "course-1",
			attemptId,
			submissionId: `submission-${attemptId}`,
			submittedAt: "2026-07-26T12:00:00.000Z",
			checkId: "check-1",
			revisionId: "revision-1",
			score: 100,
			passed: true,
			pointsAwarded: 1,
			pointsPossible: 1,
			questions: [
				{
					questionId: "question-1",
					correct: true,
					pointsAwarded: 1,
					pointsPossible: 1,
				},
			],
		},
	};
}

describe("Assessment storage adapter", () => {
	it("paginates drafts and keeps revisions immutable", async () => {
		const drafts = createCollection<DraftCheck>();
		const revisions = createCollection<AssessmentRevisionRecord>();
		const heads = createCollection<{ checkId: string; revisionId: string }>();
		const attempts = createCollection<AssessmentAttemptRecord>();
		const storage = createAssessmentStorageAdapter({
			drafts: drafts satisfies AssessmentDraftCollection,
			revisions: revisions satisfies AssessmentRevisionCollection,
			heads: heads satisfies AssessmentHeadCollection,
			attempts: attempts satisfies AssessmentAttemptCollection,
		});
		await storage.putDraft(draft("check-1"));
		await storage.putDraft(draft("check-2"));
		const revision: AssessmentRevisionRecord = {
			courseId: "course-1",
			checkId: "check-1",
			revisionId: "revision-1",
			content: {
				title: "Published check",
				passingScore: 70,
				questions: [],
			},
			publishedAt: "2026-07-26T11:00:00.000Z",
		};

		await storage.createRevision(revision);

		await expect(storage.listDrafts()).resolves.toHaveLength(2);
		await expect(storage.getRevision("revision-1")).resolves.toEqual(revision);
		await expect(storage.createRevision(revision)).rejects.toThrow(/already exists/u);
	});

	it("moves and archives only the published head", async () => {
		const storage = createAssessmentStorageAdapter({
			drafts: createCollection<DraftCheck>() satisfies AssessmentDraftCollection,
			revisions:
				createCollection<AssessmentRevisionRecord>() satisfies AssessmentRevisionCollection,
			heads: createCollection<{
				checkId: string;
				revisionId: string;
			}>() satisfies AssessmentHeadCollection,
			attempts: createCollection<AssessmentAttemptRecord>() satisfies AssessmentAttemptCollection,
		});

		await storage.setHead("check-1", "revision-1");

		await expect(storage.getHead("check-1")).resolves.toBe("revision-1");
		await expect(storage.archiveHead("check-1")).resolves.toBe(true);
		await expect(storage.getHead("check-1")).resolves.toBeUndefined();
		await expect(storage.archiveHead("check-1")).resolves.toBe(false);
	});

	it("paginates and erases attempts by opaque learner key only", async () => {
		const attempts = createCollection<AssessmentAttemptRecord>();
		const storage = createAssessmentStorageAdapter({
			drafts: createCollection<DraftCheck>() satisfies AssessmentDraftCollection,
			revisions:
				createCollection<AssessmentRevisionRecord>() satisfies AssessmentRevisionCollection,
			heads: createCollection<{
				checkId: string;
				revisionId: string;
			}>() satisfies AssessmentHeadCollection,
			attempts: attempts satisfies AssessmentAttemptCollection,
		});
		await storage.createAttempt("attempt-key-1", attempt("learner-key-a", "attempt-1"));
		await storage.createAttempt("attempt-key-2", attempt("learner-key-a", "attempt-2"));
		await storage.createAttempt("attempt-key-3", attempt("learner-key-b", "attempt-3"));

		await expect(storage.listAttempts("learner-key-a")).resolves.toHaveLength(2);
		await expect(storage.eraseLearnerAttempts("learner-key-a")).resolves.toBe(2);
		await expect(storage.listAttempts("learner-key-a")).resolves.toEqual([]);
		await expect(storage.listAttempts("learner-key-b")).resolves.toHaveLength(1);
	});

	it("erases a scale-shaped attempt history in bounded batches", async () => {
		const attempts = createCollection<AssessmentAttemptRecord>();
		for (let index = 0; index < 205; index += 1) {
			attempts.documents.set(`mine-${index}`, attempt("learner-key-a", `attempt-mine-${index}`));
		}
		for (let index = 0; index < 15; index += 1) {
			attempts.documents.set(`other-${index}`, attempt("learner-key-b", `attempt-other-${index}`));
		}
		const deleteMany = vi.spyOn(attempts, "deleteMany");
		const storage = createAssessmentStorageAdapter({
			drafts: createCollection<DraftCheck>() satisfies AssessmentDraftCollection,
			revisions:
				createCollection<AssessmentRevisionRecord>() satisfies AssessmentRevisionCollection,
			heads: createCollection<{
				checkId: string;
				revisionId: string;
			}>() satisfies AssessmentHeadCollection,
			attempts: attempts satisfies AssessmentAttemptCollection,
		});

		await expect(storage.eraseLearnerAttempts("learner-key-a")).resolves.toBe(205);
		await expect(storage.eraseLearnerAttempts("learner-key-a")).resolves.toBe(0);

		expect(deleteMany).toHaveBeenCalledTimes(3);
		expect(deleteMany.mock.calls.every(([ids]) => ids.length <= 100)).toBe(true);
		expect(attempts.documents.size).toBe(15);
		expect(
			[...attempts.documents.values()].every(({ learnerKey }) => learnerKey === "learner-key-b"),
		).toBe(true);
	});

	it("re-reads the immutable winner after a composite uniqueness race", async () => {
		const attempts = createCollection<AssessmentAttemptRecord>();
		const put = attempts.put.bind(attempts);
		attempts.put = async (id, data) => {
			const duplicate = [...attempts.documents.entries()].find(
				([existingId, existing]) =>
					existingId !== id &&
					existing.learnerKey === data.learnerKey &&
					existing.submissionId === data.submissionId,
			);
			if (duplicate) throw new Error("UNIQUE constraint failed");
			await put(id, data);
		};
		const storage = createAssessmentStorageAdapter({
			drafts: createCollection<DraftCheck>() satisfies AssessmentDraftCollection,
			revisions:
				createCollection<AssessmentRevisionRecord>() satisfies AssessmentRevisionCollection,
			heads: createCollection<{
				checkId: string;
				revisionId: string;
			}>() satisfies AssessmentHeadCollection,
			attempts: attempts satisfies AssessmentAttemptCollection,
		});
		const winner = attempt("learner-key-a", "attempt-1");
		const loser = {
			...attempt("learner-key-a", "attempt-2"),
			submissionId: winner.submissionId,
		};

		await expect(storage.createAttempt("attempt-key-1", winner)).resolves.toBe("created");
		await expect(storage.createAttempt("attempt-key-2", loser)).resolves.toBe("duplicate");
		await expect(storage.getAttempt(winner.learnerKey, winner.submissionId)).resolves.toEqual(
			winner,
		);
		expect(attempts.documents.get("attempt-key-1")).toEqual(winner);
		expect(attempts.documents.has("attempt-key-2")).toBe(false);
	});
});

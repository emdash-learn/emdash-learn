import { describe, expect, it } from "vitest";
import type { StorageCollection } from "emdash";

import type {
	AssessmentAttemptRecord,
	AssessmentRevisionRecord,
	DraftCheck,
} from "../../../src/modules/assessment/index.js";
import type { StoredEngagementObservation } from "../../../src/modules/engagement-reporting/index.js";
import type { CompletionFact } from "../../../src/modules/learning-record/index.js";
import { createLearnRuntimeServices } from "../../../src/runtime/services.js";
import { DIGEST_SECRET_KEY } from "../../../src/kv-keys.js";
import { requireInstallationDigest } from "../../../src/security/installation-digest.js";
import { createMemoryStorageCollection } from "../../utils/memory-storage.js";
import { createRouteContext } from "../../utils/route-context.js";

describe("Learn runtime services", () => {
	it("isolates process-local public rate limits between plugin installations", async () => {
		const services = createLearnRuntimeServices({
			now: () => new Date("2026-07-26T12:00:00.000Z"),
			nextUuid: () => "00000000-0000-4000-8000-000000000001",
		});
		const firstInstallation = createRouteContext(
			{},
			{
				kvValues: {
					[DIGEST_SECRET_KEY]: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				},
			},
		);
		const secondInstallation = createRouteContext(
			{},
			{
				kvValues: {
					[DIGEST_SECRET_KEY]: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
				},
			},
		);

		for (let request = 0; request < 120; request += 1) {
			// oxlint-disable-next-line no-await-in-loop -- fill one fixed-window bucket
			await services.beforePublicAssessment(firstInstallation);
		}
		await expect(services.beforePublicAssessment(firstInstallation)).rejects.toMatchObject({
			code: "LEARN_RATE_LIMITED",
		});
		await expect(services.beforePublicAssessment(secondInstallation)).resolves.toBeUndefined();
	});

	it("persists verified attempts and engagement with keyed identities and no raw answers", async () => {
		const attempts = createMemoryStorageCollection<AssessmentAttemptRecord>();
		const observations = createMemoryStorageCollection<StoredEngagementObservation>();
		const completions = createMemoryStorageCollection<CompletionFact>();
		const storage: Record<string, StorageCollection> = {
			assessment_drafts: createMemoryStorageCollection<DraftCheck>(),
			assessment_revisions: createMemoryStorageCollection<AssessmentRevisionRecord>(),
			assessment_heads: createMemoryStorageCollection<{ checkId: string; revisionId: string }>(),
			assessment_attempts: attempts,
			lesson_completions: completions,
			engagement_observations: observations,
		};
		const ctx = createRouteContext(
			{},
			{
				storage,
				kvValues: {
					[DIGEST_SECRET_KEY]: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				},
			},
		);
		const services = createLearnRuntimeServices({
			now: () => new Date("2026-07-26T12:00:00.000Z"),
			nextUuid: (() => {
				let value = 0;
				return () => `00000000-0000-4000-8000-${String(++value).padStart(12, "0")}`;
			})(),
		});
		const assessment = await services.createAssessment(ctx);
		const created = await assessment.createDraft({
			courseId: "course-typescript",
			title: "Runtime boundary",
			passingScore: 70,
			questions: [
				{
					id: "question-1",
					type: "short_text",
					prompt: "Secret answer?",
					points: 1,
					acceptedAnswers: ["private-answer"],
					explanation: "Authored explanation must not persist with an Attempt.",
				},
			],
		});
		const published = await assessment.publish(created.checkId);
		if (!published) throw new Error("Expected published revision");

		await assessment.submitAttempt(
			{ kind: "verified", learnerId: "core-user-sensitive" },
			{
				courseId: "course-typescript",
				checkId: created.checkId,
				revisionId: published.revisionId,
				submissionId: "submission-1",
				answers: [{ questionId: "question-1", answer: "private-answer" }],
			},
		);
		const reporting = await services.createReporting(ctx);
		await reporting.observe({
			type: "course_opened",
			courseId: "course-typescript",
			actor: { kind: "verified", learnerId: "core-user-sensitive" },
		});

		const digest = await requireInstallationDigest(ctx.kv);
		await completions.put("completion-mine", {
			learnerKey: await digest(
				"learning-owner",
				JSON.stringify(["learner", "core-user-sensitive"]),
			),
			courseId: "course-typescript",
			lessonId: "lesson-runtime",
			completedAt: "2026-07-26T12:00:00.000Z",
			source: "learner",
			operationId: "operation-runtime",
		});
		const persisted = JSON.stringify({
			attempts: [...attempts.documents.values()],
			completions: [...completions.documents.values()],
			observations: [...observations.documents.values()],
		});
		expect(persisted).not.toContain("core-user-sensitive");
		expect(persisted).not.toContain("private-answer");
		expect(persisted).not.toContain("Authored explanation");
		expect(persisted).toContain('"learnerKey"');
		expect(persisted).toContain('"actorKey"');

		const erasure = await services.createPrivacyErasure(ctx);
		await expect(
			erasure.eraseMyData({
				kind: "verified",
				learnerId: "core-user-sensitive",
			}),
		).resolves.toMatchObject({
			deleted: {
				lessonCompletions: 1,
				assessmentAttempts: 1,
				rawEngagementObservations: 1,
			},
		});
		expect(completions.documents.size).toBe(0);
		expect(attempts.documents.size).toBe(0);
		expect(observations.documents.size).toBe(0);
	});

	it("requires the authored course to remain published before Assessment access", async () => {
		const courseIndex = createMemoryStorageCollection();
		const ctx = createRouteContext({}, { storage: { course_content_index: courseIndex } });
		let status: "draft" | "published" = "published";
		ctx.content = {
			async get(collection, id) {
				if (collection !== "courses" || id !== "course-typescript") return null;
				return {
					id,
					type: "courses",
					slug: "typescript",
					status,
					locale: "en",
					data: { title: "TypeScript" },
					createdAt: "2026-07-26T10:00:00.000Z",
					updatedAt: "2026-07-26T10:00:00.000Z",
					publishedAt: status === "published" ? "2026-07-26T10:00:00.000Z" : null,
				};
			},
			async list() {
				return { items: [], hasMore: false };
			},
		};
		const services = createLearnRuntimeServices();

		await expect(
			services.requirePublishedAssessmentCourse(ctx, "course-typescript"),
		).resolves.toBeUndefined();
		status = "draft";
		await expect(
			services.requirePublishedAssessmentCourse(ctx, "course-typescript"),
		).rejects.toMatchObject({ code: "LEARN_CONTENT_NOT_FOUND", status: 404 });
	});
});

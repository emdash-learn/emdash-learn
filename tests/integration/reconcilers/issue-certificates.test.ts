/**
 * Integration tests for `reconcilers/issue-certificates.ts` (T14).
 *
 * Covers both sweeps:
 *   - Backfill missing certs for completed enrollments; idempotent on
 *     repeat runs.
 *   - Auto-submit stuck quiz attempts whose startedAt is older than the
 *     72h safety window.
 */

import { afterEach, describe, expect, it } from "vitest";

import { issueCertificatesReconciler } from "../../../src/reconcilers/issue-certificates.js";
import type { Certificate, QuizAttempt } from "../../../src/types/storage.js";
import {
	seedCourse,
	seedEnrollment,
	seedQuiz,
	seedStudent,
} from "../../utils/seed.js";
import { createTestPluginCtx } from "../../utils/test-plugin-ctx.js";

type TestCtx = Awaited<ReturnType<typeof createTestPluginCtx>>;

const contexts: TestCtx[] = [];

async function newCtx(): Promise<TestCtx> {
	const ctx = await createTestPluginCtx();
	contexts.push(ctx);
	return ctx;
}

afterEach(async () => {
	const pending = contexts.splice(0, contexts.length);
	await Promise.all(pending.map((ctx) => ctx.teardown()));
});

describe("reconcilers/issue-certificates backfill", () => {
	it("issues a cert for each completed enrollment without one", async () => {
		const { ctx } = await newCtx();
		const s1 = await seedStudent(ctx, { email: "ic1@test.local" });
		const s2 = await seedStudent(ctx, { email: "ic2@test.local" });
		const s3 = await seedStudent(ctx, { email: "ic3@test.local" });
		const course = await seedCourse(ctx, { title: "IC Course" });
		const completedAt = new Date().toISOString();
		await seedEnrollment(ctx, { userId: s1.id, courseId: course.id, completedAt });
		await seedEnrollment(ctx, { userId: s2.id, courseId: course.id, completedAt });
		await seedEnrollment(ctx, { userId: s3.id, courseId: course.id });

		const result = await issueCertificatesReconciler(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.processed).toBe(2);

		const certsStore = (
			ctx.storage as unknown as {
				certificates: { query: (opts: { where: Record<string, unknown> }) => Promise<{ items: Array<{ data: Certificate }> }> };
			}
		).certificates;
		const page = await certsStore.query({ where: {} });
		expect(page.items).toHaveLength(2);
	});

	it("is idempotent across repeat runs", async () => {
		const { ctx } = await newCtx();
		const s1 = await seedStudent(ctx, { email: "ic4@test.local" });
		const course = await seedCourse(ctx, { title: "IC Course 2" });
		const completedAt = new Date().toISOString();
		await seedEnrollment(ctx, { userId: s1.id, courseId: course.id, completedAt });

		const first = await issueCertificatesReconciler(ctx);
		expect(first.ok && first.data.processed).toBe(1);

		const second = await issueCertificatesReconciler(ctx);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.data.processed).toBe(0);
		expect(second.data.skipped).toBeGreaterThanOrEqual(1);

		const certsStore = (
			ctx.storage as unknown as {
				certificates: { query: (opts: { where: Record<string, unknown> }) => Promise<{ items: unknown[] }> };
			}
		).certificates;
		const page = await certsStore.query({ where: {} });
		expect(page.items).toHaveLength(1);
	});
});

describe("reconcilers/issue-certificates auto-submit stuck attempts", () => {
	it("finalizes a quiz attempt whose startedAt is older than 72h", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "ic5@test.local" });
		const quiz = await seedQuiz(ctx, {
			title: "Stuck",
			passingScore: 70,
			questions: [
				{
					id: "q1",
					type: "mcq",
					prompt: "2+2?",
					options: [
						{ id: "a", text: "3", correct: false },
						{ id: "b", text: "4", correct: true },
					],
					points: 1,
				},
			],
		});
		const attemptsStore = (
			ctx.storage as unknown as {
				quiz_attempts: {
					put: (id: string, data: Record<string, unknown>) => Promise<void>;
					get: (id: string) => Promise<QuizAttempt | null>;
				};
			}
		).quiz_attempts;
		const stuckStartedAt = new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString();
		await attemptsStore.put("att_1", {
			userId: student.id,
			quizId: quiz.id,
			startedAt: stuckStartedAt,
			answers: [],
		});

		const result = await issueCertificatesReconciler(ctx);
		expect(result.ok).toBe(true);

		const refreshed = await attemptsStore.get("att_1");
		expect(refreshed?.submittedAt).toBeDefined();
	});
});

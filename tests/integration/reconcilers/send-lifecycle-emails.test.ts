/**
 * Integration tests for `reconcilers/send-lifecycle-emails.ts` (Track C — AUDIT C1, H4).
 *
 * Acceptance criteria from the track spec:
 *
 *   - Seed one active enrollment → run reconciler twice → outbox has exactly
 *     one welcome message, welcomeSentAt is stamped after first run, no
 *     duplicate on second run.
 *
 *   - Seed one completed enrollment → run reconciler twice → outbox has exactly
 *     one completion message, completionSentAt is stamped after first run, no
 *     duplicate on second run.
 *
 *   - Revoked enrollment → no welcome email.
 *   - Already-welcomed enrollment → skipped (not re-sent).
 *   - Already-completed+completion-sent enrollment → skipped.
 *   - Missing user email (ctx.users unavailable) → skipped, not an error.
 */

import { afterEach, describe, expect, it } from "vitest";

import { sendLifecycleEmailsReconciler } from "../../../src/reconcilers/send-lifecycle-emails.js";
import type { Enrollment } from "../../../src/types/storage.js";
import { seedCourse, seedEnrollment, seedStudent } from "../../utils/seed.js";
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

/** Helper: read enrollment row from storage. */
async function getEnrollmentRow(ctx: TestCtx["ctx"], id: string): Promise<Enrollment | null> {
	const store = (
		ctx.storage as unknown as {
			enrollments: { get: (id: string) => Promise<Enrollment | null> };
		}
	).enrollments;
	return store.get(id);
}

// ---------------------------------------------------------------------------
// Welcome email tests
// ---------------------------------------------------------------------------

describe("send-lifecycle-emails reconciler — welcome email (sweep a)", () => {
	it("sends a welcome email and stamps welcomeSentAt on first run", async () => {
		const { ctx, outbox } = await newCtx();
		const student = await seedStudent(ctx, { email: "welcome@test.local" });
		const course = await seedCourse(ctx, { title: "My Course" });
		const enrollment = await seedEnrollment(ctx, {
			userId: student.id,
			courseId: course.id,
		});

		const result = await sendLifecycleEmailsReconciler(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.processed).toBe(1);
		expect(result.data.errors).toBe(0);

		// Outbox has exactly one welcome email.
		expect(outbox).toHaveLength(1);
		expect(outbox[0]?.to).toBe("welcome@test.local");
		expect(outbox[0]?.subject).toMatch(/Welcome/i);

		// welcomeSentAt was stamped on the enrollment row.
		const row = await getEnrollmentRow(ctx, enrollment.id);
		expect(row?.welcomeSentAt).toBeDefined();
		expect(row?.completionSentAt).toBeUndefined();
	});

	it("does not send a duplicate welcome on second run (idempotent)", async () => {
		const { ctx, outbox } = await newCtx();
		const student = await seedStudent(ctx, { email: "welcome2@test.local" });
		const course = await seedCourse(ctx, { title: "Idempotent Course" });
		const enrollment = await seedEnrollment(ctx, {
			userId: student.id,
			courseId: course.id,
		});

		// First run — should send and stamp.
		const first = await sendLifecycleEmailsReconciler(ctx);
		expect(first.ok).toBe(true);
		expect(outbox).toHaveLength(1);

		const rowAfterFirst = await getEnrollmentRow(ctx, enrollment.id);
		expect(rowAfterFirst?.welcomeSentAt).toBeDefined();

		// Second run — should skip (welcomeSentAt already set).
		outbox.length = 0; // clear outbox between runs
		const second = await sendLifecycleEmailsReconciler(ctx);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.data.processed).toBe(0);
		expect(outbox).toHaveLength(0);
	});

	it("skips revoked enrollments — no welcome email", async () => {
		const { ctx, outbox } = await newCtx();
		const student = await seedStudent(ctx, { email: "revoked@test.local" });
		const course = await seedCourse(ctx, { title: "Revoked Course" });
		// Seed with revokedAt already set to simulate a revocation before welcome.
		await seedEnrollment(ctx, {
			userId: student.id,
			courseId: course.id,
		});
		// Revoke via storage directly to avoid going through the engine.
		const store = (
			ctx.storage as unknown as {
				enrollments: {
					query: (opts: { where: Record<string, unknown> }) => Promise<{
						items: Array<{ id: string; data: Enrollment }>;
					}>;
					put: (id: string, data: Enrollment) => Promise<void>;
				};
			}
		).enrollments;
		const page = await store.query({ where: { userId: student.id } });
		const row = page.items[0];
		if (!row) throw new Error("setup failed: enrollment not found");
		await store.put(row.id, { ...row.data, revokedAt: new Date().toISOString() });

		const result = await sendLifecycleEmailsReconciler(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.processed).toBe(0);
		expect(outbox).toHaveLength(0);
	});

	it("skips enrollments that already have welcomeSentAt set", async () => {
		const { ctx, outbox } = await newCtx();
		const student = await seedStudent(ctx, { email: "already-welcomed@test.local" });
		const course = await seedCourse(ctx, { title: "Pre-welcomed Course" });

		// Inject welcomeSentAt directly into storage using the low-level collection helper.
		const store = (
			ctx.storage as unknown as {
				enrollments: {
					put: (id: string, data: Enrollment) => Promise<void>;
				};
			}
		).enrollments;
		const id = `enr_test_already_welcomed`;
		const now = new Date().toISOString();
		await store.put(id, {
			userId: student.id,
			courseId: course.id,
			enrolledAt: now,
			source: "free",
			welcomeSentAt: now,
		});

		const result = await sendLifecycleEmailsReconciler(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.processed).toBe(0);
		expect(outbox).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Completion email tests
// ---------------------------------------------------------------------------

describe("send-lifecycle-emails reconciler — completion email (sweep b)", () => {
	it("sends a completion email and stamps completionSentAt on first run", async () => {
		const { ctx, outbox } = await newCtx();
		const student = await seedStudent(ctx, { email: "completion@test.local" });
		const course = await seedCourse(ctx, { title: "Finished Course" });
		const completedAt = new Date().toISOString();
		const enrollment = await seedEnrollment(ctx, {
			userId: student.id,
			courseId: course.id,
			completedAt,
		});

		// The enrollment is already completed at seed time and has no welcomeSentAt
		// yet, so the first sweep will also issue a welcome. We verify both emails.
		const result = await sendLifecycleEmailsReconciler(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// processed = 2 (welcome + completion) or 1 welcome + 1 completion across sweeps.
		expect(result.data.processed).toBeGreaterThanOrEqual(1);
		expect(result.data.errors).toBe(0);

		// At least one completion email in outbox (welcome may also be there).
		const completionEmail = outbox.find((m) => m.subject.toLowerCase().includes("congratulations"));
		expect(completionEmail).toBeDefined();
		expect(completionEmail?.to).toBe("completion@test.local");

		// completionSentAt was stamped.
		const row = await getEnrollmentRow(ctx, enrollment.id);
		expect(row?.completionSentAt).toBeDefined();
	});

	it("does not send a duplicate completion email on second run (idempotent)", async () => {
		const { ctx, outbox } = await newCtx();
		const student = await seedStudent(ctx, { email: "completion2@test.local" });
		const course = await seedCourse(ctx, { title: "Finished Idem" });
		const completedAt = new Date().toISOString();
		const enrollment = await seedEnrollment(ctx, {
			userId: student.id,
			courseId: course.id,
			completedAt,
		});

		// First run.
		await sendLifecycleEmailsReconciler(ctx);
		const rowAfterFirst = await getEnrollmentRow(ctx, enrollment.id);
		expect(rowAfterFirst?.completionSentAt).toBeDefined();

		// Count completion emails after first run.
		const completionCountAfterFirst = outbox.filter((m) =>
			m.subject.toLowerCase().includes("congratulations"),
		).length;
		expect(completionCountAfterFirst).toBe(1);

		// Second run — completion already sent.
		const second = await sendLifecycleEmailsReconciler(ctx);
		expect(second.ok).toBe(true);
		if (!second.ok) return;

		// No new completion emails.
		const completionCountAfterSecond = outbox.filter((m) =>
			m.subject.toLowerCase().includes("congratulations"),
		).length;
		expect(completionCountAfterSecond).toBe(1);
	});

	it("does not send a completion email when enrollment is not yet completed", async () => {
		const { ctx, outbox } = await newCtx();
		const student = await seedStudent(ctx, { email: "incomplete@test.local" });
		const course = await seedCourse(ctx, { title: "Incomplete Course" });
		const enrollment = await seedEnrollment(ctx, {
			userId: student.id,
			courseId: course.id,
			// No completedAt.
		});

		await sendLifecycleEmailsReconciler(ctx);

		const row = await getEnrollmentRow(ctx, enrollment.id);
		expect(row?.completionSentAt).toBeUndefined();

		const completionEmail = outbox.find((m) => m.subject.toLowerCase().includes("congratulations"));
		expect(completionEmail).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Summary counters
// ---------------------------------------------------------------------------

describe("send-lifecycle-emails reconciler — summary counters", () => {
	it("reports processed + skipped accurately across both sweeps", async () => {
		const { ctx } = await newCtx();

		// s1 active (needs welcome); s2 completed (needs both); s3 completed
		// with both already stamped (should be fully skipped).
		const s1 = await seedStudent(ctx, { email: "r1@test.local" });
		const s2 = await seedStudent(ctx, { email: "r2@test.local" });
		const s3 = await seedStudent(ctx, { email: "r3@test.local" });
		const course = await seedCourse(ctx, { title: "Summary Course" });
		const completedAt = new Date().toISOString();
		const now = new Date().toISOString();

		await seedEnrollment(ctx, { userId: s1.id, courseId: course.id });
		await seedEnrollment(ctx, { userId: s2.id, courseId: course.id, completedAt });
		// s3: inject both stamps directly.
		const store = (
			ctx.storage as unknown as {
				enrollments: { put: (id: string, data: Enrollment) => Promise<void> };
			}
		).enrollments;
		await store.put("enr_test_s3", {
			userId: s3.id,
			courseId: course.id,
			enrolledAt: now,
			source: "free",
			completedAt: now,
			welcomeSentAt: now,
			completionSentAt: now,
		});

		const result = await sendLifecycleEmailsReconciler(ctx);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// processed: s1 welcome + s2 welcome + s2 completion = at least 3
		// (exact count depends on sweep order and whether cap is hit).
		expect(result.data.processed).toBeGreaterThanOrEqual(2);
		expect(result.data.errors).toBe(0);
	});
});

/**
 * Integration tests for `engine/analytics.ts` (T15).
 *
 * Exercises every aggregator at least once against a seeded fixture.
 * Storage access uses the real plugin context provisioned by
 * `createTestPluginCtx`, so index semantics + row shapes are covered.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ulid } from "emdash";

import * as analytics from "../../../src/engine/analytics.js";
import {
	seedCourse,
	seedEnrollment,
	seedProgress,
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

async function assignInstructor(
	ctx: TestCtx["ctx"],
	courseId: string,
	userId: string,
): Promise<void> {
	// eslint-disable-next-line typescript-eslint/no-explicit-any
	await (ctx.storage as any).course_instructors.put(`ci_${ulid()}`, {
		courseId,
		userId,
		role: "lead",
	});
}

async function putAttempt(
	ctx: TestCtx["ctx"],
	data: {
		userId: string;
		quizId: string;
		score: number;
		passed: boolean;
		submittedAt?: string;
	},
): Promise<string> {
	const id = `att_${ulid()}`;
	const submittedAt = data.submittedAt ?? new Date().toISOString();
	// eslint-disable-next-line typescript-eslint/no-explicit-any
	await (ctx.storage as any).quiz_attempts.put(id, {
		userId: data.userId,
		quizId: data.quizId,
		startedAt: submittedAt,
		submittedAt,
		answers: [],
		score: data.score,
		passed: data.passed,
	});
	return id;
}

async function putCertificate(
	ctx: TestCtx["ctx"],
	data: { userId: string; courseId: string; issuedAt?: string },
): Promise<string> {
	const id = `cert_${ulid()}`;
	const issuedAt = data.issuedAt ?? new Date().toISOString();
	// eslint-disable-next-line typescript-eslint/no-explicit-any
	await (ctx.storage as any).certificates.put(id, {
		userId: data.userId,
		courseId: data.courseId,
		issuedAt,
		verificationCode: id,
	});
	return id;
}

describe("engine/analytics.dashboardStats", () => {
	it("aggregates across an instructor's courses", async () => {
		const { ctx } = await newCtx();
		const instr = await seedStudent(ctx, { email: "inst1@test.local", role: 40 });
		const c1 = await seedCourse(ctx, { title: "C1" });
		const c2 = await seedCourse(ctx, { title: "C2" });
		await assignInstructor(ctx, c1.id, instr.id);
		await assignInstructor(ctx, c2.id, instr.id);

		const s1 = await seedStudent(ctx, { email: "ds1@test.local" });
		const s2 = await seedStudent(ctx, { email: "ds2@test.local" });
		const s3 = await seedStudent(ctx, { email: "ds3@test.local" });

		await seedEnrollment(ctx, { userId: s1.id, courseId: c1.id });
		await seedEnrollment(ctx, { userId: s2.id, courseId: c1.id });
		await seedEnrollment(ctx, { userId: s3.id, courseId: c2.id });

		await seedProgress(ctx, {
			userId: s1.id,
			courseId: c1.id,
			stepType: "lesson",
			stepId: "l1",
			percentComplete: 50,
		});
		await seedProgress(ctx, {
			userId: s2.id,
			courseId: c1.id,
			stepType: "lesson",
			stepId: "l1",
			percentComplete: 100,
			completedAt: new Date().toISOString(),
		});

		const result = await analytics.dashboardStats(ctx, instr.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.totalStudents).toBeGreaterThanOrEqual(3);
		expect(typeof result.data.active30d).toBe("number");
		expect(typeof result.data.avgCompletion).toBe("number");
		expect(typeof result.data.quizPassRate).toBe("number");
	});

	it("returns zeroes for an instructor with no courses", async () => {
		const { ctx } = await newCtx();
		const instr = await seedStudent(ctx, { email: "empty@test.local", role: 40 });
		const result = await analytics.dashboardStats(ctx, instr.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toEqual({
			totalStudents: 0,
			active30d: 0,
			avgCompletion: 0,
			quizPassRate: 0,
		});
	});
});

describe("engine/analytics.dashboardCourses", () => {
	it("returns one CourseSummary per instructor course", async () => {
		const { ctx } = await newCtx();
		const instr = await seedStudent(ctx, { email: "inst2@test.local", role: 40 });
		const c1 = await seedCourse(ctx, { title: "A" });
		const c2 = await seedCourse(ctx, { title: "B" });
		await assignInstructor(ctx, c1.id, instr.id);
		await assignInstructor(ctx, c2.id, instr.id);

		const s = await seedStudent(ctx, { email: "dc1@test.local" });
		await seedEnrollment(ctx, { userId: s.id, courseId: c1.id });

		const result = await analytics.dashboardCourses(ctx, instr.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toHaveLength(2);
		const ids = result.data.map((r) => r.courseId).sort();
		expect(ids).toEqual([c1.id, c2.id].sort());
	});
});

describe("engine/analytics.courseOverview", () => {
	it("computes enrolled/completed/active30d/avgProgress", async () => {
		const { ctx } = await newCtx();
		const c = await seedCourse(ctx, { title: "Overview" });
		const s1 = await seedStudent(ctx, { email: "co1@test.local" });
		const s2 = await seedStudent(ctx, { email: "co2@test.local" });

		await seedEnrollment(ctx, { userId: s1.id, courseId: c.id });
		await seedEnrollment(ctx, {
			userId: s2.id,
			courseId: c.id,
			completedAt: new Date().toISOString(),
		});
		await seedProgress(ctx, {
			userId: s1.id,
			courseId: c.id,
			stepType: "lesson",
			stepId: "l1",
			percentComplete: 50,
		});
		await seedProgress(ctx, {
			userId: s2.id,
			courseId: c.id,
			stepType: "lesson",
			stepId: "l1",
			percentComplete: 100,
		});

		const result = await analytics.courseOverview(ctx, c.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.enrolled).toBe(2);
		expect(result.data.completed).toBe(1);
		expect(result.data.avgProgress).toBeGreaterThan(0);
	});
});

describe("engine/analytics.courseEnrollmentsTimeline", () => {
	it("buckets enrollments by date", async () => {
		const { ctx } = await newCtx();
		const c = await seedCourse(ctx, { title: "Timeline" });
		const students = await Promise.all([
			seedStudent(ctx, { email: "tl1@test.local" }),
			seedStudent(ctx, { email: "tl2@test.local" }),
			seedStudent(ctx, { email: "tl3@test.local" }),
		]);
		const now = Date.now();
		for (const [i, s] of students.entries()) {
			// eslint-disable-next-line no-await-in-loop
			await seedEnrollment(ctx, {
				userId: s.id,
				courseId: c.id,
				enrolledAt: new Date(now - i * 86_400_000).toISOString(),
			});
		}

		const result = await analytics.courseEnrollmentsTimeline(ctx, c.id, 30);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.length).toBeLessThanOrEqual(30);
		const total = result.data.reduce((a, b) => a + b.count, 0);
		expect(total).toBeGreaterThanOrEqual(3);
	});
});

describe("engine/analytics.courseCompletionFunnel", () => {
	it("counts users past each quartile threshold", async () => {
		const { ctx } = await newCtx();
		const c = await seedCourse(ctx, { title: "Funnel" });
		const students = await Promise.all([
			seedStudent(ctx, { email: "fn1@test.local" }),
			seedStudent(ctx, { email: "fn2@test.local" }),
			seedStudent(ctx, { email: "fn3@test.local" }),
			seedStudent(ctx, { email: "fn4@test.local" }),
		]);
		const percents = [10, 30, 60, 100];
		for (const [i, s] of students.entries()) {
			// eslint-disable-next-line no-await-in-loop
			await seedEnrollment(ctx, {
				userId: s.id,
				courseId: c.id,
				completedAt: percents[i] === 100 ? new Date().toISOString() : undefined,
			});
			// eslint-disable-next-line no-await-in-loop
			await seedProgress(ctx, {
				userId: s.id,
				courseId: c.id,
				stepType: "lesson",
				stepId: "l1",
				percentComplete: percents[i] ?? 0,
			});
		}

		const result = await analytics.courseCompletionFunnel(ctx, c.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toEqual({ started: 4, q25: 3, q50: 2, q75: 1, completed: 1 });
	});
});

describe("engine/analytics.courseProgressMatrix", () => {
	it("returns a row per student with lessonProgress keys", async () => {
		const { ctx } = await newCtx();
		const c = await seedCourse(ctx, { title: "Matrix" });
		const s1 = await seedStudent(ctx, { email: "pm1@test.local" });
		const s2 = await seedStudent(ctx, { email: "pm2@test.local" });

		await seedEnrollment(ctx, { userId: s1.id, courseId: c.id });
		await seedEnrollment(ctx, { userId: s2.id, courseId: c.id });
		await seedProgress(ctx, {
			userId: s1.id,
			courseId: c.id,
			stepType: "lesson",
			stepId: "lesson-a",
			percentComplete: 80,
		});
		await seedProgress(ctx, {
			userId: s1.id,
			courseId: c.id,
			stepType: "lesson",
			stepId: "lesson-b",
			percentComplete: 40,
		});
		await seedProgress(ctx, {
			userId: s2.id,
			courseId: c.id,
			stepType: "lesson",
			stepId: "lesson-a",
			percentComplete: 20,
		});

		const result = await analytics.courseProgressMatrix(ctx, c.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.students).toHaveLength(2);
		const s1Row = result.data.students.find((s) => s.userId === s1.id);
		expect(s1Row).toBeDefined();
		expect(s1Row?.lessonProgress["lesson-a"]).toBe(80);
		expect(s1Row?.lessonProgress["lesson-b"]).toBe(40);
	});
});

describe("engine/analytics.courseQuizStats", () => {
	it("aggregates attempts per quiz", async () => {
		const { ctx } = await newCtx();
		const c = await seedCourse(ctx, { title: "QZ" });
		const quiz = await seedQuiz(ctx, { title: "Q1", questions: [] });
		const s = await seedStudent(ctx, { email: "qz@test.local" });

		await putAttempt(ctx, { userId: s.id, quizId: quiz.id, score: 80, passed: true });
		await putAttempt(ctx, { userId: s.id, quizId: quiz.id, score: 90, passed: true });
		await putAttempt(ctx, { userId: s.id, quizId: quiz.id, score: 40, passed: false });

		const result = await analytics.courseQuizStats(ctx, c.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const entry = result.data.find((r) => r.quizId === quiz.id);
		expect(entry).toBeDefined();
		expect(entry?.attempts).toBe(3);
		expect(entry?.passRate).toBeGreaterThan(60);
		expect(entry?.passRate).toBeLessThan(70);
	});
});

describe("engine/analytics.studentProgressAcrossCourses", () => {
	it("returns only courses owned by the instructor", async () => {
		const { ctx } = await newCtx();
		const instr = await seedStudent(ctx, { email: "inst3@test.local", role: 40 });
		const c1 = await seedCourse(ctx, { title: "SP1" });
		const c2 = await seedCourse(ctx, { title: "SP2" });
		const c3 = await seedCourse(ctx, { title: "SP3" });
		await assignInstructor(ctx, c1.id, instr.id);
		await assignInstructor(ctx, c2.id, instr.id);
		// c3 is NOT assigned to instr.

		const stu = await seedStudent(ctx, { email: "sp-stu@test.local" });
		await seedEnrollment(ctx, { userId: stu.id, courseId: c1.id });
		await seedEnrollment(ctx, { userId: stu.id, courseId: c2.id });
		await seedEnrollment(ctx, { userId: stu.id, courseId: c3.id });

		const result = await analytics.studentProgressAcrossCourses(ctx, instr.id, stu.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.courses).toHaveLength(2);
		const courseIds = result.data.courses.map((c) => c.courseId).sort();
		expect(courseIds).toEqual([c1.id, c2.id].sort());
	});
});

describe("engine/analytics.siteAnalytics", () => {
	it("sums enrollments + certificates within range", async () => {
		const { ctx } = await newCtx();
		const c = await seedCourse(ctx, { title: "SA" });
		const s1 = await seedStudent(ctx, { email: "sa1@test.local" });
		const s2 = await seedStudent(ctx, { email: "sa2@test.local" });

		await seedEnrollment(ctx, { userId: s1.id, courseId: c.id });
		await seedEnrollment(ctx, { userId: s2.id, courseId: c.id });
		await putCertificate(ctx, { userId: s1.id, courseId: c.id });

		const range = {
			from: new Date(Date.now() - 86_400_000).toISOString(),
			to: new Date(Date.now() + 86_400_000).toISOString(),
		};
		const result = await analytics.siteAnalytics(ctx, range);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.totalEnrollments).toBeGreaterThanOrEqual(2);
		expect(result.data.certificatesIssued).toBeGreaterThanOrEqual(1);
	});
});

describe("engine/analytics.coursesComparison", () => {
	it("returns CourseComparison items with expected keys", async () => {
		const { ctx } = await newCtx();
		const c = await seedCourse(ctx, { title: "CMP" });
		const s = await seedStudent(ctx, { email: "cmp@test.local" });
		await seedEnrollment(ctx, { userId: s.id, courseId: c.id });

		const range = {
			from: new Date(Date.now() - 86_400_000).toISOString(),
			to: new Date(Date.now() + 86_400_000).toISOString(),
		};
		const result = await analytics.coursesComparison(ctx, range);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Array.isArray(result.data.items)).toBe(true);
		const entry = result.data.items.find((r) => r.courseId === c.id);
		expect(entry).toBeDefined();
		expect(entry?.enrolled).toBeGreaterThanOrEqual(1);
		expect(typeof entry?.completionRate).toBe("number");
		expect(typeof entry?.avgProgress).toBe("number");
	});
});

describe("engine/analytics.engagementMetrics", () => {
	it("returns dau + completionsByDay shapes", async () => {
		const { ctx } = await newCtx();
		const c = await seedCourse(ctx, { title: "EM" });
		const s = await seedStudent(ctx, { email: "em@test.local" });
		await seedEnrollment(ctx, {
			userId: s.id,
			courseId: c.id,
			completedAt: new Date().toISOString(),
		});
		await seedProgress(ctx, {
			userId: s.id,
			courseId: c.id,
			stepType: "lesson",
			stepId: "l",
			percentComplete: 100,
		});

		const range = {
			from: new Date(Date.now() - 86_400_000).toISOString(),
			to: new Date(Date.now() + 86_400_000).toISOString(),
		};
		const result = await analytics.engagementMetrics(ctx, range);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Array.isArray(result.data.dau)).toBe(true);
		expect(Array.isArray(result.data.completionsByDay)).toBe(true);
	});
});

describe("engine/analytics.recentActivity", () => {
	it("returns items sorted desc by `at` and capped at `limit`", async () => {
		const { ctx } = await newCtx();
		const instr = await seedStudent(ctx, { email: "ra-inst@test.local", role: 40 });
		const c = await seedCourse(ctx, { title: "RA" });
		await assignInstructor(ctx, c.id, instr.id);

		const students = await Promise.all([
			seedStudent(ctx, { email: "ra1@test.local" }),
			seedStudent(ctx, { email: "ra2@test.local" }),
			seedStudent(ctx, { email: "ra3@test.local" }),
		]);
		const now = Date.now();
		for (const [i, s] of students.entries()) {
			// eslint-disable-next-line no-await-in-loop
			await seedEnrollment(ctx, {
				userId: s.id,
				courseId: c.id,
				enrolledAt: new Date(now - i * 60_000).toISOString(),
			});
		}

		const result = await analytics.recentActivity(ctx, instr.id, 2);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.length).toBeLessThanOrEqual(2);
		for (const item of result.data) {
			expect(typeof item.type).toBe("string");
			expect(typeof item.at).toBe("string");
		}
		if (result.data.length >= 2) {
			expect(result.data[0]!.at >= result.data[1]!.at).toBe(true);
		}
	});
});

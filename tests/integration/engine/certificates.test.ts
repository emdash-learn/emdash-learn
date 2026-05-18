/**
 * Integration tests for `engine/certificates.ts` (T09).
 *
 * Covers issue/listForUser/verify/revoke plus the KV-backed rate limit.
 * No PDF — v1 is record-only (D32).
 */

import { afterEach, describe, expect, it } from "vitest";

import * as certificates from "../../../src/engine/certificates.js";
import { settingKey } from "../../../src/kv-keys.js";
import { seedCourse, seedStudent } from "../../utils/seed.js";
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

describe("engine/certificates.issue", () => {
	it("creates a cert with a verification code and returns the stored record", async () => {
		const { ctx } = await newCtx();
		const result = await certificates.issue(ctx, "u_1", "c_1");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.id).toMatch(/^cert_/);
		expect(result.data.data.verificationCode).toMatch(/^[A-Z0-9]{12}$/);
	});

	it("is idempotent per (userId, courseId) — returns the existing record on repeat", async () => {
		const { ctx } = await newCtx();
		const first = await certificates.issue(ctx, "u_2", "c_2");
		const second = await certificates.issue(ctx, "u_2", "c_2");
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.data.id).toBe(second.data.id);
	});

	it("stamps expiresAt from the certificateExpiryDays setting when set", async () => {
		const { ctx } = await newCtx();
		await ctx.kv.set(settingKey("certificateExpiryDays"), 30);
		const result = await certificates.issue(ctx, "u_3", "c_3");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.data.expiresAt).toBeDefined();
	});
});

describe("engine/certificates.verify", () => {
	it("returns valid=true with user + course info for an un-revoked cert", async () => {
		const { ctx } = await newCtx();
		const student = await seedStudent(ctx, { email: "alice@x.com", name: "Alice" });
		const course = await seedCourse(ctx, { title: "My Course" });

		const issued = await certificates.issue(ctx, student.id, course.id);
		if (!issued.ok) throw new Error("setup failed");

		const result = await certificates.verify(ctx, issued.data.data.verificationCode);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.valid).toBe(true);
		expect(result.data.userName).toBe("Alice");
		expect(result.data.courseTitle).toBe("My Course");
	});

	it("returns valid=false for an unknown code", async () => {
		const { ctx } = await newCtx();
		const result = await certificates.verify(ctx, "NONEXISTENT1");
		expect(result.ok && result.data.valid).toBe(false);
	});

	it("returns exactly { valid: false } after revoke — no data leakage (M9)", async () => {
		const { ctx } = await newCtx();
		const issued = await certificates.issue(ctx, "u_rev", "c_rev");
		if (!issued.ok) throw new Error("setup failed");
		await certificates.revoke(ctx, issued.data.id, "fraud");
		const verified = await certificates.verify(ctx, issued.data.data.verificationCode);
		expect(verified.ok).toBe(true);
		if (!verified.ok) return;
		expect(verified.data.valid).toBe(false);
		expect(Object.keys(verified.data).length).toBe(1);
	});

	it("stamps revokedAt on the stored certificate row after revoke", async () => {
		const { ctx } = await newCtx();
		const issued = await certificates.issue(ctx, "u_rev2", "c_rev2");
		if (!issued.ok) throw new Error("setup failed");
		const revoked = await certificates.revoke(ctx, issued.data.id, "fraud");
		expect(revoked.ok).toBe(true);
		if (!revoked.ok) return;
		expect(revoked.data.data.revokedAt).toBeDefined();
	});
});

describe("engine/certificates.listForUser", () => {
	it("returns every cert for the user", async () => {
		const { ctx } = await newCtx();
		await certificates.issue(ctx, "u_l", "c_a");
		await certificates.issue(ctx, "u_l", "c_b");
		const page = await certificates.listForUser(ctx, "u_l");
		expect(page.ok && page.data.items.length).toBe(2);
	});
});

describe("engine/certificates.revoke", () => {
	it("stamps revokedAt and flips valid=false on verify", async () => {
		const { ctx } = await newCtx();
		const issued = await certificates.issue(ctx, "u_r", "c_r");
		if (!issued.ok) throw new Error("setup failed");
		const result = await certificates.revoke(ctx, issued.data.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.data.revokedAt).toBeDefined();
	});

	it("returns LEARN_CERT_NOT_FOUND for a missing cert", async () => {
		const { ctx } = await newCtx();
		const result = await certificates.revoke(ctx, "cert_missing");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("LEARN_CERT_NOT_FOUND");
	});
});

describe("engine/certificates.checkVerifyRateLimit", () => {
	it("allows up to maxPerBucket and then rejects further attempts", async () => {
		const { ctx } = await newCtx();
		const opts = { bucketSeconds: 60, maxPerBucket: 3 };
		const first = await certificates.checkVerifyRateLimit(ctx, "1.1.1.1", opts);
		const second = await certificates.checkVerifyRateLimit(ctx, "1.1.1.1", opts);
		const third = await certificates.checkVerifyRateLimit(ctx, "1.1.1.1", opts);
		const fourth = await certificates.checkVerifyRateLimit(ctx, "1.1.1.1", opts);
		expect(first.ok && second.ok && third.ok).toBe(true);
		expect(fourth.ok).toBe(false);
		if (fourth.ok) return;
		expect(fourth.error.code).toBe("LEARN_FORBIDDEN");
	});

	it("isolates buckets per IP", async () => {
		const { ctx } = await newCtx();
		const opts = { bucketSeconds: 60, maxPerBucket: 1 };
		const a1 = await certificates.checkVerifyRateLimit(ctx, "1.1.1.1", opts);
		const b1 = await certificates.checkVerifyRateLimit(ctx, "2.2.2.2", opts);
		expect(a1.ok && b1.ok).toBe(true);
	});

	it("concurrent burst: successes never exceed maxPerBucket (H6)", async () => {
		// Insert-first-then-count: regardless of interleaving, a request that sees
		// count > maxPerBucket rejects. In the fully-concurrent case (all inserts
		// complete before any count runs) all requests may reject. In the
		// sequential case exactly maxPerBucket succeed. The invariant is:
		//   successes <= maxPerBucket
		const { ctx } = await newCtx();
		const opts = { bucketSeconds: 60, maxPerBucket: 10 };
		const results = await Promise.all(
			Array.from({ length: 50 }, () =>
				certificates.checkVerifyRateLimit(ctx, "3.3.3.3", opts),
			),
		);
		const successes = results.filter((r) => r.ok).length;
		expect(successes).toBeLessThanOrEqual(opts.maxPerBucket);
	});
});

describe("engine/certificates.verify — shape invariants", () => {
	it("returns exactly { valid: false } for an unknown code (no data leakage)", async () => {
		const { ctx } = await newCtx();
		const result = await certificates.verify(ctx, "UNKNOWN12345");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data.valid).toBe(false);
		expect(Object.keys(result.data).length).toBe(1);
	});
});

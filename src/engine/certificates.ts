/**
 * Certificates engine (T09 / §22 / §5.3 / §6.1 + §6.2).
 *
 * Record-only in v1 (D32): no PDF rendering, no `pdfStorageKey`. The
 * `verification_code` is a 12-char base32-ish random string surfaced in the
 * `certificate:verify` public route. A v1.1 patch can add PDF generation
 * as a pure additive feature.
 *
 *   issue(ctx, userId, courseId)        — idempotent per (user, course).
 *   listForUser(ctx, userId, opts?)     — paginated personal listing.
 *   verify(ctx, code)                   — lookup by code for the public page.
 *   revoke(ctx, certId, reason?)        — admin-triggered revocation.
 *
 * No events are emitted from this module — T14's issue-certificates cron
 * reconciler calls `issue()` on course:completed handlers, and the admin
 * revoke flow is wired up in Wave 6.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { ulid } from "emdash";

import { COURSES_COLLECTION_SLUG, LEARN_ERRORS } from "../constants.js";
import { settingKey } from "../kv-keys.js";
import type { Certificate } from "../types/storage.js";
import { err, ok, type Result } from "./result.js";

const CERTIFICATES = "certificates";

function certsStore(ctx: PluginContext): StorageCollection<Certificate> {
	const s = (ctx.storage as Record<string, StorageCollection | undefined>)[CERTIFICATES];
	if (!s) throw new Error(`Plugin storage collection "${CERTIFICATES}" is not declared.`);
	return s as StorageCollection<Certificate>;
}

export interface CertificateRecord {
	id: string;
	data: Certificate;
}

/**
 * 12-char verification code (~60 bits of entropy). Crockford-style alphabet
 * avoids lookalike chars (0/O, 1/I/L) so a student can retype the code from a
 * paper certificate without ambiguity.
 */
function generateVerificationCode(): string {
	// 32 chars divides 256 evenly — no modulo bias when mapping bytes[i] % 32.
	const alpha = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	let out = "";
	for (const byte of bytes) out += alpha[byte % 32]!;
	return out;
}

async function findExistingForCourse(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<CertificateRecord | null> {
	const page = await certsStore(ctx).query({
		where: { userId, courseId },
		limit: 1,
	});
	const row = page.items[0];
	return row ? { id: row.id, data: row.data } : null;
}

/**
 * Issue a certificate for `(userId, courseId)`. Idempotent: if a cert already
 * exists (whether active or revoked), the existing row is returned unchanged.
 * Callers that need to re-issue after revocation can `revoke` then `issue`;
 * the engine deliberately leaves the existing row in place so historical
 * records stay stable.
 */
export async function issue(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<Result<CertificateRecord>> {
	if (!userId || !courseId) {
		return err(LEARN_ERRORS.FORBIDDEN, "userId and courseId are required");
	}

	const existing = await findExistingForCourse(ctx, userId, courseId);
	if (existing) return ok(existing);

	const expiryDays = (await ctx.kv.get<number | null>(settingKey("certificateExpiryDays"))) as
		| number
		| null;

	const id = `cert_${ulid()}`;
	const now = new Date();
	const data: Certificate = {
		userId,
		courseId,
		issuedAt: now.toISOString(),
		verificationCode: generateVerificationCode(),
	};
	if (typeof expiryDays === "number" && expiryDays > 0) {
		data.expiresAt = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000).toISOString();
	}

	await certsStore(ctx).put(id, data);
	ctx.log.info("certificate issued", { id, userId, courseId });
	return ok({ id, data });
}

export interface ListOptions {
	cursor?: string;
	limit?: number;
}

export interface PaginatedCertificates {
	items: CertificateRecord[];
	cursor?: string;
	hasMore: boolean;
}

export async function listForUser(
	ctx: PluginContext,
	userId: string,
	opts: ListOptions = {},
): Promise<Result<PaginatedCertificates>> {
	const page = await certsStore(ctx).query({
		where: { userId },
		limit: opts.limit,
		cursor: opts.cursor,
	});
	const out: PaginatedCertificates = {
		items: page.items.map((r) => ({ id: r.id, data: r.data })),
		hasMore: page.hasMore,
	};
	if (page.cursor !== undefined) out.cursor = page.cursor;
	return ok(out);
}

export type VerificationResult =
	| { valid: false }
	| { valid: true; issuedAt: string; userName?: string; courseTitle?: string; expiresAt?: string };

/**
 * Public verification. Resolves to `{ valid: true, ... }` only for
 * active certs; revoked or expired certs return exactly `{ valid: false }`
 * with no additional fields (M9 — no data leakage on invalid codes).
 */
export async function verify(
	ctx: PluginContext,
	code: string,
): Promise<Result<VerificationResult>> {
	const trimmed = code.trim().toUpperCase();
	if (!trimmed) return ok({ valid: false });

	const page = await certsStore(ctx).query({
		where: { verificationCode: trimmed },
		limit: 1,
	});
	const row = page.items[0];
	if (!row) return ok({ valid: false });

	const cert = row.data;

	const expired = cert.expiresAt ? Date.parse(cert.expiresAt) < Date.now() : false;
	if (cert.revokedAt || expired) return ok({ valid: false });

	let userName: string | undefined;
	if (ctx.users?.get) {
		const user = await ctx.users.get(cert.userId);
		if (user?.name) userName = user.name;
		else if (user?.email) userName = user.email;
	}

	let courseTitle: string | undefined;
	if (ctx.content) {
		const course = await ctx.content.get(COURSES_COLLECTION_SLUG, cert.courseId);
		if (course) {
			const title = (course.data as Record<string, unknown>)["title"];
			if (typeof title === "string") courseTitle = title;
		}
	}

	const result: VerificationResult = { valid: true, issuedAt: cert.issuedAt ?? "" };
	if (userName) result.userName = userName;
	if (courseTitle) result.courseTitle = courseTitle;
	if (cert.expiresAt) result.expiresAt = cert.expiresAt;
	return ok(result);
}

export async function revoke(
	ctx: PluginContext,
	certId: string,
	reason?: string,
): Promise<Result<CertificateRecord>> {
	const existing = await certsStore(ctx).get(certId);
	if (!existing) {
		return err(LEARN_ERRORS.CERT_NOT_FOUND, `Certificate ${certId} not found`);
	}
	if (existing.revokedAt) {
		return ok({ id: certId, data: existing });
	}
	const updated: Certificate = {
		...existing,
		revokedAt: new Date().toISOString(),
	};
	await certsStore(ctx).put(certId, updated);
	ctx.log.info("certificate revoked", { id: certId, reason });
	return ok({ id: certId, data: updated });
}

// ---------------------------------------------------------------------------
// Rate limiting for public verify (stored in plugin storage — insert-first-
// then-count pattern; see §6.2 and AUDIT H6)
// ---------------------------------------------------------------------------

interface CertVerifyAttemptRow {
	ip: string;
	bucket: number;
	ts: number;
}

function certVerifyAttemptsStore(ctx: PluginContext): StorageCollection<CertVerifyAttemptRow> {
	const s = (ctx.storage as Record<string, StorageCollection | undefined>)[
		"cert_verify_attempts"
	];
	if (!s) throw new Error('Plugin storage collection "cert_verify_attempts" is not declared.');
	return s as StorageCollection<CertVerifyAttemptRow>;
}

/**
 * Bucketed per-IP rate limit. Window size and max both tuneable via opts so
 * an operator can raise the ceiling without a redeploy.
 *
 * Uses insert-first-then-count: each call writes one row then counts. Under
 * concurrency the count may exceed maxPerBucket by at most the number of
 * in-flight requests; the limit is bounded, not strictly exact. Old bucket
 * rows are dead weight (no GC in v1 — follow-up task).
 */
export interface RateLimitOpts {
	bucketSeconds: number;
	maxPerBucket: number;
}

export const DEFAULT_VERIFY_RATE_LIMIT: RateLimitOpts = {
	bucketSeconds: 60,
	maxPerBucket: 30,
};

export async function checkVerifyRateLimit(
	ctx: PluginContext,
	ip: string,
	opts: RateLimitOpts = DEFAULT_VERIFY_RATE_LIMIT,
): Promise<Result<{ remaining: number }>> {
	const bucket = Math.floor(Date.now() / 1000 / opts.bucketSeconds);
	const store = certVerifyAttemptsStore(ctx);
	await store.put(`rl_${ulid()}`, { ip, bucket, ts: Date.now() });
	const current = await store.count({ ip, bucket });
	if (current > opts.maxPerBucket) {
		return err(
			LEARN_ERRORS.FORBIDDEN,
			"Too many certificate verification requests — try again shortly",
		);
	}
	return ok({ remaining: Math.max(opts.maxPerBucket - current, 0) });
}

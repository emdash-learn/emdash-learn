/**
 * Public certificate verification route (T09 / §6.2).
 *
 *   certificate:verify  { code } → { valid, issuedAt?, userName?, courseTitle?, revokedAt?, expiresAt? }
 *
 * No auth. Rate-limited per IP via KV (§6.2 + D32) to prevent brute-force
 * code enumeration. `ctx.requestMeta.ip` is the bucket key; missing IPs
 * fall into a shared "unknown" bucket so the limit still applies.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute } from "emdash";

import { LEARN_ERRORS } from "../constants.js";
import * as certificates from "../engine/certificates.js";
import type { Result, ResultError } from "../engine/result.js";

export const certificateVerifyInput = z.object({
	code: z.string().min(1).max(64),
});
export type CertificateVerifyInput = z.infer<typeof certificateVerifyInput>;

function statusForCode(code: string): number {
	if (code === LEARN_ERRORS.FORBIDDEN) return 429;
	return 400;
}

function toRouteError(error: ResultError): PluginRouteError {
	return new PluginRouteError(error.code, error.message, statusForCode(error.code));
}

function unwrap<T>(result: Result<T>): T {
	if (!result.ok) throw toRouteError(result.error);
	return result.data;
}

const verifyRoute: PluginRoute<CertificateVerifyInput> = {
	input: certificateVerifyInput,
	handler: async (ctx) => {
		const requestMeta = (ctx as { requestMeta?: { ip?: string | null } }).requestMeta;
		const ip = requestMeta?.ip ?? "unknown";
		unwrap(await certificates.checkVerifyRateLimit(ctx, ip));

		const result = unwrap(await certificates.verify(ctx, ctx.input.code));
		return result;
	},
};

export const certificateRoutesPublic = {
	"certificate:verify": verifyRoute,
} as const;

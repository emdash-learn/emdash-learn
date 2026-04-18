/**
 * Student-facing certificate route (T09 / §6.1).
 *
 *   certificates:mine  { cursor?, limit? } → paginated certs for the
 *                                            authenticated student.
 *
 * Record-only (D32). Returns the raw cert row so the theme can render a
 * verification URL from `verificationCode` locally.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute } from "emdash";

import { type AuthContext, Role, requireRole } from "../authz.js";
import { LEARN_ERRORS } from "../constants.js";
import * as certificates from "../engine/certificates.js";
import type { Result, ResultError } from "../engine/result.js";

export const certificatesMineInput = z.object({
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(100).optional(),
});
export type CertificatesMineInput = z.infer<typeof certificatesMineInput>;

function statusForCode(code: string): number {
	if (code === LEARN_ERRORS.UNAUTHENTICATED) return 401;
	if (code === LEARN_ERRORS.FORBIDDEN) return 403;
	return 400;
}

function toRouteError(error: ResultError): PluginRouteError {
	return new PluginRouteError(error.code, error.message, statusForCode(error.code));
}

function unwrap<T>(result: Result<T>): T {
	if (!result.ok) throw toRouteError(result.error);
	return result.data;
}

const mineRoute: PluginRoute<CertificatesMineInput> = {
	input: certificatesMineInput,
	handler: async (ctx) => {
		const auth = ctx as unknown as AuthContext;
		const user = requireRole(auth, Role.SUBSCRIBER);
		if (!user.ok) throw toRouteError(user.error);

		const opts: certificates.ListOptions = {};
		if (ctx.input.cursor !== undefined) opts.cursor = ctx.input.cursor;
		if (ctx.input.limit !== undefined) opts.limit = ctx.input.limit;
		const page = unwrap(await certificates.listForUser(ctx, user.data.id, opts));
		return {
			items: page.items.map((r) => ({ id: r.id, ...r.data })),
			cursor: page.cursor,
			hasMore: page.hasMore,
		};
	},
};

export const certificateRoutesStudent = {
	"certificates:mine": mineRoute,
} as const;

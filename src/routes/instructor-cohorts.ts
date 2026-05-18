/**
 * Instructor cohort routes (T10 / §6.3).
 *
 * Six POST endpoints, all `EDITOR`-gated:
 *   - cohort:create       { slug, title, startAt?, endAt?, capacity? }
 *   - cohort:list         { cursor?, limit? }
 *   - cohort:get          { cohortId }
 *   - cohort:add-member   { cohortId, userId, role? }
 *   - cohort:remove-member{ cohortId, userId }
 *   - cohort:import       { cohortId, emails? } | { cohortId, csv? }
 *
 * `cohort:get` returns `{ cohort, members }` — the admin detail page
 * (§16.6) needs the member roster alongside cohort metadata; the engine
 * already exposes `cohorts.get()`, so this just wires a route to it.
 *
 * `cohort:import` accepts either an `emails` array (UI input) or a `csv`
 * string (paste-a-sheet flow). Exactly one must be provided. CSV is split
 * on commas or newlines; emails are trimmed and de-duped before dispatch
 * to the engine. Unknown emails + already-members come back on the response
 * per D50 — the engine never creates users implicitly.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute } from "emdash";

import { type AuthContext, Role, requireRole } from "../authz.js";
import { LEARN_ERRORS } from "../constants.js";
import * as cohorts from "../engine/cohorts.js";
import type { Result, ResultError } from "../engine/result.js";
import { ensureSetupComplete } from "../setup-gate.js";

// ---------------------------------------------------------------------------
// Zod schemas (§23 + D50 import)
// ---------------------------------------------------------------------------

export const cohortCreateInput = z.object({
	slug: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase alphanumeric with dashes")
		.max(63),
	title: z.string().min(1).max(200),
	startAt: z.string().datetime().optional(),
	endAt: z.string().datetime().optional(),
	capacity: z.number().int().min(1).optional(),
});
export type CohortCreateInput = z.infer<typeof cohortCreateInput>;

export const cohortListInput = z.object({
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(100).optional(),
});
export type CohortListInput = z.infer<typeof cohortListInput>;

export const cohortGetInput = z.object({
	cohortId: z.string().min(1),
});
export type CohortGetInput = z.infer<typeof cohortGetInput>;

export const cohortAddMemberInput = z.object({
	cohortId: z.string().min(1),
	userId: z.string().min(1),
	role: z.enum(["student", "ta"]).optional(),
});
export type CohortAddMemberInput = z.infer<typeof cohortAddMemberInput>;

export const cohortRemoveMemberInput = z.object({
	cohortId: z.string().min(1),
	userId: z.string().min(1),
});
export type CohortRemoveMemberInput = z.infer<typeof cohortRemoveMemberInput>;

export const cohortImportInput = z
	.object({
		cohortId: z.string().min(1),
		emails: z.array(z.string().email()).min(1).max(500).optional(),
		csv: z.string().min(1).max(200_000).optional(),
	})
	.refine(
		(v) => Boolean(v.emails?.length) || Boolean(v.csv),
		"either `emails` or `csv` must be provided",
	);
export type CohortImportInput = z.infer<typeof cohortImportInput>;

// ---------------------------------------------------------------------------
// Error → HTTP mapping
// ---------------------------------------------------------------------------

function statusForCode(code: string): number {
	switch (code) {
		case LEARN_ERRORS.UNAUTHENTICATED:
			return 401;
		case LEARN_ERRORS.FORBIDDEN:
		case LEARN_ERRORS.NOT_INSTRUCTOR:
			return 403;
		case LEARN_ERRORS.COHORT_AT_CAPACITY:
		case LEARN_ERRORS.SCHEMA_CONFLICT:
		case LEARN_ERRORS.SETUP_INCOMPLETE:
			return 409;
		default:
			return 400;
	}
}

function toRouteError(error: ResultError): PluginRouteError {
	return new PluginRouteError(error.code, error.message, statusForCode(error.code));
}

function unwrap<T>(result: Result<T>): T {
	if (!result.ok) throw toRouteError(result.error);
	return result.data;
}

function gate(ctx: unknown): void {
	const auth = ctx as AuthContext;
	const user = requireRole(auth, Role.EDITOR);
	if (!user.ok) throw toRouteError(user.error);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const createRoute: PluginRoute<CohortCreateInput> = {
	input: cohortCreateInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		gate(ctx);
		const record = unwrap(await cohorts.create(ctx, ctx.input));
		return { id: record.id, cohort: record.data };
	},
};

const listRoute: PluginRoute<CohortListInput> = {
	input: cohortListInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		gate(ctx);
		const opts: cohorts.ListOptions = {};
		if (ctx.input.cursor !== undefined) opts.cursor = ctx.input.cursor;
		if (ctx.input.limit !== undefined) opts.limit = ctx.input.limit;
		const page = unwrap(await cohorts.list(ctx, opts));
		const counts = await cohorts.memberCountsByCohort(ctx);
		return {
			items: page.items.map((r) => ({
				id: r.id,
				memberCount: counts[r.id] ?? 0,
				...r.data,
			})),
			cursor: page.cursor,
			hasMore: page.hasMore,
		};
	},
};

const getRoute: PluginRoute<CohortGetInput> = {
	input: cohortGetInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		gate(ctx);
		const result = unwrap(await cohorts.get(ctx, ctx.input.cohortId));
		return {
			id: result.cohort.id,
			cohort: result.cohort.data,
			members: result.members.map((m) => ({ id: m.id, ...m.data })),
		};
	},
};

const addMemberRoute: PluginRoute<CohortAddMemberInput> = {
	input: cohortAddMemberInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		gate(ctx);
		const record = unwrap(
			await cohorts.addMember(
				ctx,
				ctx.input.cohortId,
				ctx.input.userId,
				ctx.input.role ?? "student",
			),
		);
		return { id: record.id, member: record.data };
	},
};

const removeMemberRoute: PluginRoute<CohortRemoveMemberInput> = {
	input: cohortRemoveMemberInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		gate(ctx);
		unwrap(await cohorts.removeMember(ctx, ctx.input.cohortId, ctx.input.userId));
		return { ok: true };
	},
};

/**
 * Parse CSV into a trimmed, de-duped email list. Accepts commas or newlines
 * as separators — matches the spreadsheet-paste flow the admin UI offers.
 * Empty / whitespace-only tokens are dropped.
 */
function parseCsvEmails(csv: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const token of csv.split(/[\n,]/)) {
		const email = token.trim();
		if (!email) continue;
		const key = email.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(email);
	}
	return out;
}

const importRoute: PluginRoute<CohortImportInput> = {
	input: cohortImportInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		gate(ctx);
		const emails = ctx.input.emails ?? (ctx.input.csv ? parseCsvEmails(ctx.input.csv) : []);
		if (emails.length === 0) {
			throw new PluginRouteError(LEARN_ERRORS.FORBIDDEN, "no emails were provided", 400);
		}
		const result = unwrap(await cohorts.importFromEmails(ctx, ctx.input.cohortId, emails));
		return {
			added: result.added.map((r) => ({ id: r.id, ...r.data })),
			unknownEmails: result.unknownEmails,
			alreadyMembers: result.alreadyMembers,
			capacityRejected: result.capacityRejected,
			counts: {
				added: result.added.length,
				unknown: result.unknownEmails.length,
				alreadyMembers: result.alreadyMembers.length,
				capacityRejected: result.capacityRejected.length,
			},
		};
	},
};

export const cohortRoutes = {
	"cohort:create": createRoute,
	"cohort:list": listRoute,
	"cohort:get": getRoute,
	"cohort:add-member": addMemberRoute,
	"cohort:remove-member": removeMemberRoute,
	"cohort:import": importRoute,
} as const;

/**
 * Cohorts engine (T10 / §22 / §5.3 / §6.3).
 *
 * Owns two plugin-storage collections:
 *   - `cohorts` (unique on slug)
 *   - `cohort_members` (unique on (cohortId, userId))
 *
 * Capacity handling (D43): on `addMember`, we read-then-write. At v1 scale we
 * accept that two concurrent adds can both see `count < capacity` and both
 * succeed, producing a 1–2-seat overage. The alternative (serializable
 * transaction across two collections) buys us little at v1 traffic and adds
 * a lot of complexity; the admin UI reconciliation flow would cover the rare
 * overshoot.
 *
 * Email import (D50): `importFromEmails` matches users by email only. Unknown
 * emails are returned so the instructor can act on them (invite separately,
 * fix typos) — the engine never creates users on the fly.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { ulid } from "emdash";

import { LEARN_ERRORS } from "../constants.js";
import type {
	Cohort,
	CohortMember,
	CohortMemberRole,
} from "../types/storage.js";
import { err, ok, type Result } from "./result.js";

const COHORTS = "cohorts";
const COHORT_MEMBERS = "cohort_members";

function cohortsStore(ctx: PluginContext): StorageCollection<Cohort> {
	const s = (ctx.storage as Record<string, StorageCollection | undefined>)[COHORTS];
	if (!s) throw new Error(`Plugin storage collection "${COHORTS}" is not declared.`);
	return s as StorageCollection<Cohort>;
}

function membersStore(ctx: PluginContext): StorageCollection<CohortMember> {
	const s = (ctx.storage as Record<string, StorageCollection | undefined>)[COHORT_MEMBERS];
	if (!s) throw new Error(`Plugin storage collection "${COHORT_MEMBERS}" is not declared.`);
	return s as StorageCollection<CohortMember>;
}

export interface CohortInput {
	slug: string;
	title: string;
	startAt?: string;
	endAt?: string;
	capacity?: number;
}

export interface CohortRecord {
	id: string;
	data: Cohort;
}

export interface CohortMemberRecord {
	id: string;
	data: CohortMember;
}

export async function create(
	ctx: PluginContext,
	input: CohortInput,
): Promise<Result<CohortRecord>> {
	if (!input.slug || !input.title) {
		return err(LEARN_ERRORS.FORBIDDEN, "slug and title are required");
	}

	const existing = await cohortsStore(ctx).query({ where: { slug: input.slug }, limit: 1 });
	if (existing.items.length > 0) {
		return err(LEARN_ERRORS.SCHEMA_CONFLICT, `Cohort slug "${input.slug}" already exists`);
	}

	const id = `coh_${ulid()}`;
	const data: Cohort = {
		slug: input.slug,
		title: input.title,
		createdAt: new Date().toISOString(),
	};
	if (input.startAt !== undefined) data.startAt = input.startAt;
	if (input.endAt !== undefined) data.endAt = input.endAt;
	if (input.capacity !== undefined) data.capacity = input.capacity;

	await cohortsStore(ctx).put(id, data);
	ctx.log.info("cohort created", { id, slug: data.slug });
	return ok({ id, data });
}

export interface ListOptions {
	cursor?: string;
	limit?: number;
}

export interface PaginatedCohorts {
	items: CohortRecord[];
	cursor?: string;
	hasMore: boolean;
}

export async function list(
	ctx: PluginContext,
	opts: ListOptions = {},
): Promise<Result<PaginatedCohorts>> {
	const page = await cohortsStore(ctx).query({
		limit: opts.limit,
		cursor: opts.cursor,
		orderBy: { slug: "asc" },
	});
	const out: PaginatedCohorts = {
		items: page.items.map((r) => ({ id: r.id, data: r.data })),
		hasMore: page.hasMore,
	};
	if (page.cursor !== undefined) out.cursor = page.cursor;
	return ok(out);
}

export async function get(
	ctx: PluginContext,
	cohortId: string,
): Promise<Result<{ cohort: CohortRecord; members: CohortMemberRecord[] }>> {
	const row = await cohortsStore(ctx).get(cohortId);
	if (!row) return err(LEARN_ERRORS.SETUP_INCOMPLETE, `Cohort ${cohortId} not found`);
	const members = await membersStore(ctx).query({ where: { cohortId } });
	return ok({
		cohort: { id: cohortId, data: row },
		members: members.items.map((m) => ({ id: m.id, data: m.data })),
	});
}

export async function addMember(
	ctx: PluginContext,
	cohortId: string,
	userId: string,
	role: CohortMemberRole = "student",
): Promise<Result<CohortMemberRecord>> {
	if (!cohortId || !userId) {
		return err(LEARN_ERRORS.FORBIDDEN, "cohortId and userId are required");
	}

	const cohort = await cohortsStore(ctx).get(cohortId);
	if (!cohort) {
		return err(LEARN_ERRORS.SETUP_INCOMPLETE, `Cohort ${cohortId} not found`);
	}

	// D43: read-then-write capacity check. 1–2 overage tolerated at v1 scale.
	if (typeof cohort.capacity === "number") {
		const current = await membersStore(ctx).query({ where: { cohortId } });
		if (current.items.length >= cohort.capacity) {
			return err(
				LEARN_ERRORS.COHORT_AT_CAPACITY,
				`Cohort ${cohortId} is at capacity (${cohort.capacity})`,
			);
		}
	}

	const existing = await membersStore(ctx).query({
		where: { cohortId, userId },
		limit: 1,
	});
	if (existing.items.length > 0) {
		// Idempotent: already a member — no-op success with the existing row.
		const row = existing.items[0]!;
		return ok({ id: row.id, data: row.data });
	}

	const id = `cm_${ulid()}`;
	const data: CohortMember = {
		cohortId,
		userId,
		role,
		joinedAt: new Date().toISOString(),
	};
	await membersStore(ctx).put(id, data);
	ctx.log.info("cohort member added", { id, cohortId, userId, role });
	return ok({ id, data });
}

export async function removeMember(
	ctx: PluginContext,
	cohortId: string,
	userId: string,
): Promise<Result<void>> {
	const existing = await membersStore(ctx).query({
		where: { cohortId, userId },
		limit: 1,
	});
	const row = existing.items[0];
	if (!row) return ok(undefined);
	await membersStore(ctx).delete(row.id);
	ctx.log.info("cohort member removed", { cohortId, userId });
	return ok(undefined);
}

export interface ImportResult {
	added: CohortMemberRecord[];
	unknownEmails: string[];
	alreadyMembers: string[];
}

interface UsersLookup {
	getByEmail(email: string): Promise<{ id: string; email: string } | null>;
}

/**
 * Resolve emails → userIds via `ctx.users.getByEmail`, then call `addMember`
 * for each resolved user. Unknown emails come back verbatim so the caller
 * (instructor UI) can show them to the admin for follow-up (D50).
 */
export async function importFromEmails(
	ctx: PluginContext,
	cohortId: string,
	emails: string[],
): Promise<Result<ImportResult>> {
	const cohort = await cohortsStore(ctx).get(cohortId);
	if (!cohort) {
		return err(LEARN_ERRORS.SETUP_INCOMPLETE, `Cohort ${cohortId} not found`);
	}

	const users = (ctx as unknown as { users?: UsersLookup }).users;
	if (!users?.getByEmail) {
		return err(
			LEARN_ERRORS.SETUP_INCOMPLETE,
			"ctx.users.getByEmail is unavailable — grant read:users capability",
		);
	}

	const added: CohortMemberRecord[] = [];
	const unknownEmails: string[] = [];
	const alreadyMembers: string[] = [];

	// Sequential: membership add is read-then-write and capacity checks need
	// to see the state each previous add produced.
	/* oxlint-disable no-await-in-loop */
	for (const rawEmail of emails) {
		const email = rawEmail.trim();
		if (!email) continue;
		const user = await users.getByEmail(email);
		if (!user) {
			unknownEmails.push(email);
			continue;
		}
		const existing = await membersStore(ctx).query({
			where: { cohortId, userId: user.id },
			limit: 1,
		});
		if (existing.items.length > 0) {
			alreadyMembers.push(email);
			continue;
		}
		const res = await addMember(ctx, cohortId, user.id, "student");
		if (res.ok) added.push(res.data);
		// If addMember fails (e.g. capacity), the email neither succeeds nor
		// is "unknown" — surface via counts.added shortfall.
	}
	/* oxlint-enable no-await-in-loop */

	return ok({ added, unknownEmails, alreadyMembers });
}

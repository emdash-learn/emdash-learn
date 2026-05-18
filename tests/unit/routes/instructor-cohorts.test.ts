/**
 * Unit tests for `src/routes/instructor-cohorts.ts` (T10).
 *
 * Verifies:
 *   - The exported `cohortRoutes` table holds exactly the five §6.3 names.
 *   - Each handler validates input through the inline Zod schema and routes
 *     to the engine.
 *   - `EDITOR` role gating is enforced via `requireRole`.
 *   - `cohort:import` accepts both an `emails` array and a `csv` string and
 *     surfaces the unknown-emails report (D50) in the response payload.
 *
 * The engine is exercised against a stub `ctx.storage` similar to the cohorts
 * engine tests; route input is validated by parsing the schema explicitly so
 * we can call the handler with already-typed `ctx.input`.
 */

import { describe, expect, it, vi } from "vitest";

import { Role } from "../../../src/authz.js";
import { BOOTSTRAP_VERSION, LEARN_ERRORS } from "../../../src/constants.js";
import { BOOTSTRAP_STATE_KEY } from "../../../src/kv-keys.js";
import { cohortRoutes } from "../../../src/routes/instructor-cohorts.js";
import type { Cohort, CohortMember } from "../../../src/types/storage.js";

/** Minimal KV stub with bootstrap state pre-seeded so `ensureSetupComplete` passes. */
function makeKvStub() {
	const store = new Map<string, unknown>([
		[BOOTSTRAP_STATE_KEY, { version: BOOTSTRAP_VERSION, completedSteps: [] }],
	]);
	return {
		async get<T>(key: string): Promise<T | null> {
			return (store.get(key) as T | undefined) ?? null;
		},
	};
}

interface StoredRow<T> {
	id: string;
	data: T;
}

function whereMatches(data: Record<string, unknown>, where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([k, v]) => data[k] === v);
}

function makeStub<T extends Record<string, unknown>>(uniqueOn?: Array<keyof T & string>) {
	const rows: StoredRow<T>[] = [];
	function uniqueClash(data: T, ignoreId?: string): boolean {
		if (!uniqueOn || uniqueOn.length === 0) return false;
		return rows.some(
			(r) =>
				r.id !== ignoreId &&
				uniqueOn.every((k) => (r.data as Record<string, unknown>)[k] === data[k]),
		);
	}
	return {
		rows,
		async get(id: string): Promise<T | null> {
			return rows.find((r) => r.id === id)?.data ?? null;
		},
		async put(id: string, data: T): Promise<void> {
			if (uniqueClash(data, id)) throw new Error("UNIQUE constraint failed");
			const i = rows.findIndex((r) => r.id === id);
			if (i >= 0) rows[i] = { id, data };
			else rows.push({ id, data });
		},
		async delete(id: string): Promise<boolean> {
			const i = rows.findIndex((r) => r.id === id);
			if (i < 0) return false;
			rows.splice(i, 1);
			return true;
		},
		async query(opts?: {
			where?: Record<string, unknown>;
			orderBy?: Record<string, "asc" | "desc">;
			limit?: number;
		}) {
			const where = opts?.where ?? {};
			let filtered = rows.filter((r) => whereMatches(r.data as Record<string, unknown>, where));
			if (opts?.orderBy) {
				const [[key, dir] = ["", "asc"]] = Object.entries(opts.orderBy);
				if (key) {
					filtered = [...filtered].sort((a, b) => {
						const av = (a.data as Record<string, unknown>)[key];
						const bv = (b.data as Record<string, unknown>)[key];
						if (av === bv) return 0;
						const cmp = (av as string | number) > (bv as string | number) ? 1 : -1;
						return dir === "desc" ? -cmp : cmp;
					});
				}
			}
			const limit = opts?.limit;
			const items = typeof limit === "number" ? filtered.slice(0, limit) : filtered;
			return { items, hasMore: typeof limit === "number" ? filtered.length > items.length : false };
		},
		async count(where?: Record<string, unknown>): Promise<number> {
			const w = where ?? {};
			return rows.filter((r) => whereMatches(r.data as Record<string, unknown>, w)).length;
		},
	};
}

interface StubUserRecord {
	id: string;
	email: string;
	name: string | null;
	role: number;
	createdAt: string;
}

interface MakeCtxOpts {
	roleLevel?: number; // role of the session user; defaults to EDITOR
	users?: Array<{ email: string; id: string }>;
}

function makeCtx(opts: MakeCtxOpts = {}) {
	const cohorts = makeStub<Cohort>(["slug"]);
	const cohortMembers = makeStub<CohortMember>(["cohortId", "userId"]);
	const userMap = new Map<string, StubUserRecord>();
	for (const u of opts.users ?? []) {
		userMap.set(u.email.toLowerCase(), {
			id: u.id,
			email: u.email,
			name: null,
			role: 10,
			createdAt: "2026-01-01T00:00:00.000Z",
		});
	}
	const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const user =
		opts.roleLevel === undefined
			? { id: "u_editor", email: "ed@x.com", name: "Ed", role: Role.EDITOR, createdAt: "" }
			: { id: "u_test", email: "t@x.com", name: "T", role: opts.roleLevel, createdAt: "" };
	const kv = makeKvStub();

	function buildRouteCtx(input: unknown) {
		return {
			input,
			storage: { cohorts, cohort_members: cohortMembers },
			log,
			user,
			kv,
			users: {
				async getByEmail(email: string) {
					return userMap.get(email.toLowerCase()) ?? null;
				},
				async get() {
					return null;
				},
				async list() {
					return { items: [] };
				},
			},
			request: new Request("https://example.invalid/_emdash/api/plugins/lms-core/test", {
				method: "POST",
			}),
			requestMeta: { ip: null, userAgent: null, referer: null, geo: null },
		} as unknown as Parameters<(typeof cohortRoutes)["cohort:create"]["handler"]>[0];
	}

	return { cohorts, cohortMembers, log, user, buildRouteCtx };
}

// ---------------------------------------------------------------------------
// Route table shape
// ---------------------------------------------------------------------------

describe("cohortRoutes table", () => {
	it("exports exactly the six §6.3 cohort names (§6.3 + cohort:get for §16.6)", () => {
		expect(Object.keys(cohortRoutes).sort()).toEqual([
			"cohort:add-member",
			"cohort:create",
			"cohort:get",
			"cohort:import",
			"cohort:list",
			"cohort:remove-member",
		]);
	});

	it("each route declares an input schema and an async handler", () => {
		for (const [, route] of Object.entries(cohortRoutes)) {
			expect(route.input).toBeDefined();
			expect(typeof route.handler).toBe("function");
		}
	});
});

// ---------------------------------------------------------------------------
// cohort:create
// ---------------------------------------------------------------------------

describe("cohort:create route", () => {
	it("creates a cohort and returns { id, cohort }", async () => {
		const { buildRouteCtx, cohorts } = makeCtx();
		const route = cohortRoutes["cohort:create"];
		const input = route.input!.parse({ slug: "spring-26", title: "Spring 26" });
		const result = (await route.handler(buildRouteCtx(input))) as {
			id: string;
			cohort: Cohort;
		};
		expect(result.id).toMatch(/^coh_/);
		expect(result.cohort.slug).toBe("spring-26");
		expect(cohorts.rows).toHaveLength(1);
	});

	it("rejects callers below EDITOR with FORBIDDEN", async () => {
		const { buildRouteCtx } = makeCtx({ roleLevel: Role.SUBSCRIBER });
		const route = cohortRoutes["cohort:create"];
		const input = route.input!.parse({ slug: "spring-26", title: "Spring 26" });
		await expect(route.handler(buildRouteCtx(input))).rejects.toMatchObject({
			code: LEARN_ERRORS.FORBIDDEN,
		});
	});

	it("rejects an unauthenticated caller with UNAUTHENTICATED", async () => {
		const { buildRouteCtx } = makeCtx();
		const route = cohortRoutes["cohort:create"];
		const input = route.input!.parse({ slug: "spring-26", title: "Spring 26" });
		const ctx = buildRouteCtx(input);
		// Strip the user to simulate the unauthenticated case at the route boundary.
		(ctx as { user: unknown }).user = null;
		await expect(route.handler(ctx)).rejects.toMatchObject({
			code: LEARN_ERRORS.UNAUTHENTICATED,
		});
	});
});

// ---------------------------------------------------------------------------
// cohort:list
// ---------------------------------------------------------------------------

describe("cohort:list route", () => {
	it("returns paginated cohorts ordered by slug, with per-cohort memberCount", async () => {
		const { buildRouteCtx } = makeCtx();
		const createRoute = cohortRoutes["cohort:create"];
		const b = (await createRoute.handler(
			buildRouteCtx(createRoute.input!.parse({ slug: "b", title: "B" })),
		)) as { id: string };
		const a = (await createRoute.handler(
			buildRouteCtx(createRoute.input!.parse({ slug: "a", title: "A" })),
		)) as { id: string };

		const addRoute = cohortRoutes["cohort:add-member"];
		await addRoute.handler(buildRouteCtx(addRoute.input!.parse({ cohortId: b.id, userId: "u1" })));
		await addRoute.handler(buildRouteCtx(addRoute.input!.parse({ cohortId: b.id, userId: "u2" })));

		const listRoute = cohortRoutes["cohort:list"];
		const result = (await listRoute.handler(buildRouteCtx(listRoute.input!.parse({})))) as {
			items: Array<{ id: string; memberCount: number } & Cohort>;
		};
		expect(result.items.map((c) => c.slug)).toEqual(["a", "b"]);
		const counts = Object.fromEntries(result.items.map((c) => [c.id, c.memberCount]));
		expect(counts[a.id]).toBe(0);
		expect(counts[b.id]).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// cohort:get
// ---------------------------------------------------------------------------

describe("cohort:get route", () => {
	it("returns { id, cohort, members } for an existing cohort", async () => {
		const { buildRouteCtx } = makeCtx();
		const createRoute = cohortRoutes["cohort:create"];
		const created = (await createRoute.handler(
			buildRouteCtx(createRoute.input!.parse({ slug: "g", title: "G" })),
		)) as { id: string };

		const addRoute = cohortRoutes["cohort:add-member"];
		await addRoute.handler(
			buildRouteCtx(addRoute.input!.parse({ cohortId: created.id, userId: "u_a" })),
		);
		await addRoute.handler(
			buildRouteCtx(addRoute.input!.parse({ cohortId: created.id, userId: "u_b", role: "ta" })),
		);

		const getRoute = cohortRoutes["cohort:get"];
		const result = (await getRoute.handler(
			buildRouteCtx(getRoute.input!.parse({ cohortId: created.id })),
		)) as {
			id: string;
			cohort: Cohort;
			members: Array<{ id: string } & CohortMember>;
		};
		expect(result.id).toBe(created.id);
		expect(result.cohort.slug).toBe("g");
		expect(result.members).toHaveLength(2);
		expect(result.members.map((m) => m.userId).sort()).toEqual(["u_a", "u_b"]);
	});

	it("rejects a missing cohort with SETUP_INCOMPLETE", async () => {
		const { buildRouteCtx } = makeCtx();
		const getRoute = cohortRoutes["cohort:get"];
		await expect(
			getRoute.handler(buildRouteCtx(getRoute.input!.parse({ cohortId: "coh_missing" }))),
		).rejects.toMatchObject({ code: LEARN_ERRORS.SETUP_INCOMPLETE });
	});

	it("rejects callers below EDITOR with FORBIDDEN", async () => {
		const { buildRouteCtx } = makeCtx({ roleLevel: Role.SUBSCRIBER });
		const getRoute = cohortRoutes["cohort:get"];
		await expect(
			getRoute.handler(buildRouteCtx(getRoute.input!.parse({ cohortId: "coh_any" }))),
		).rejects.toMatchObject({ code: LEARN_ERRORS.FORBIDDEN });
	});
});

// ---------------------------------------------------------------------------
// cohort:add-member
// ---------------------------------------------------------------------------

describe("cohort:add-member route", () => {
	it("adds a member and returns { id, member }", async () => {
		const { buildRouteCtx } = makeCtx();
		const createRoute = cohortRoutes["cohort:create"];
		const created = (await createRoute.handler(
			buildRouteCtx(createRoute.input!.parse({ slug: "am", title: "Am" })),
		)) as { id: string };

		const addRoute = cohortRoutes["cohort:add-member"];
		const result = (await addRoute.handler(
			buildRouteCtx(addRoute.input!.parse({ cohortId: created.id, userId: "u_a", role: "ta" })),
		)) as { id: string; member: CohortMember };
		expect(result.id).toMatch(/^cm_/);
		expect(result.member.role).toBe("ta");
	});

	it("propagates COHORT_AT_CAPACITY when the cohort is full", async () => {
		const { buildRouteCtx } = makeCtx();
		const createRoute = cohortRoutes["cohort:create"];
		const created = (await createRoute.handler(
			buildRouteCtx(createRoute.input!.parse({ slug: "cap-am", title: "Cap", capacity: 1 })),
		)) as { id: string };
		const addRoute = cohortRoutes["cohort:add-member"];
		await addRoute.handler(
			buildRouteCtx(addRoute.input!.parse({ cohortId: created.id, userId: "u_1" })),
		);
		await expect(
			addRoute.handler(
				buildRouteCtx(addRoute.input!.parse({ cohortId: created.id, userId: "u_2" })),
			),
		).rejects.toMatchObject({ code: LEARN_ERRORS.COHORT_AT_CAPACITY });
	});
});

// ---------------------------------------------------------------------------
// cohort:remove-member
// ---------------------------------------------------------------------------

describe("cohort:remove-member route", () => {
	it("removes an existing member and returns { ok: true }", async () => {
		const { buildRouteCtx } = makeCtx();
		const createRoute = cohortRoutes["cohort:create"];
		const created = (await createRoute.handler(
			buildRouteCtx(createRoute.input!.parse({ slug: "rm", title: "Rm" })),
		)) as { id: string };
		const addRoute = cohortRoutes["cohort:add-member"];
		await addRoute.handler(
			buildRouteCtx(addRoute.input!.parse({ cohortId: created.id, userId: "u_1" })),
		);
		const removeRoute = cohortRoutes["cohort:remove-member"];
		const result = await removeRoute.handler(
			buildRouteCtx(removeRoute.input!.parse({ cohortId: created.id, userId: "u_1" })),
		);
		expect(result).toEqual({ ok: true });
	});
});

// ---------------------------------------------------------------------------
// cohort:import (D50)
// ---------------------------------------------------------------------------

describe("cohort:import route", () => {
	it("accepts an emails array and returns the unknown-emails report (D50)", async () => {
		const { buildRouteCtx } = makeCtx({
			users: [
				{ email: "alice@x.com", id: "u_alice" },
				{ email: "bob@x.com", id: "u_bob" },
			],
		});
		const createRoute = cohortRoutes["cohort:create"];
		const created = (await createRoute.handler(
			buildRouteCtx(createRoute.input!.parse({ slug: "imp", title: "Imp" })),
		)) as { id: string };

		const importRoute = cohortRoutes["cohort:import"];
		const result = (await importRoute.handler(
			buildRouteCtx(
				importRoute.input!.parse({
					cohortId: created.id,
					emails: ["alice@x.com", "bob@x.com", "ghost@x.com"],
				}),
			),
		)) as {
			added: CohortMember[];
			unknownEmails: string[];
			alreadyMembers: string[];
			capacityRejected: string[];
			counts: {
				added: number;
				unknown: number;
				alreadyMembers: number;
				capacityRejected: number;
			};
		};
		expect(result.added).toHaveLength(2);
		expect(result.unknownEmails).toEqual(["ghost@x.com"]);
		expect(result.capacityRejected).toEqual([]);
		expect(result.counts).toEqual({
			added: 2,
			unknown: 1,
			alreadyMembers: 0,
			capacityRejected: 0,
		});
	});

	it("surfaces capacity-rejected emails in capacityRejected + counts (AUDIT M4)", async () => {
		const { buildRouteCtx } = makeCtx({
			users: [
				{ email: "alice@x.com", id: "u_alice" },
				{ email: "bob@x.com", id: "u_bob" },
				{ email: "carol@x.com", id: "u_carol" },
			],
		});
		const createRoute = cohortRoutes["cohort:create"];
		const created = (await createRoute.handler(
			buildRouteCtx(
				createRoute.input!.parse({ slug: "cap-imp", title: "Cap Imp", capacity: 2 }),
			),
		)) as { id: string };

		const importRoute = cohortRoutes["cohort:import"];
		const result = (await importRoute.handler(
			buildRouteCtx(
				importRoute.input!.parse({
					cohortId: created.id,
					emails: ["alice@x.com", "bob@x.com", "carol@x.com"],
				}),
			),
		)) as {
			added: CohortMember[];
			unknownEmails: string[];
			alreadyMembers: string[];
			capacityRejected: string[];
			counts: {
				added: number;
				unknown: number;
				alreadyMembers: number;
				capacityRejected: number;
			};
		};
		expect(result.added).toHaveLength(2);
		expect(result.capacityRejected).toEqual(["carol@x.com"]);
		expect(result.counts.capacityRejected).toBe(1);
		expect(result.counts.added).toBe(2);
	});

	it("accepts a csv string with one email per line", async () => {
		const { buildRouteCtx } = makeCtx({
			users: [{ email: "alice@x.com", id: "u_alice" }],
		});
		const createRoute = cohortRoutes["cohort:create"];
		const created = (await createRoute.handler(
			buildRouteCtx(createRoute.input!.parse({ slug: "imp-csv", title: "Csv" })),
		)) as { id: string };

		const importRoute = cohortRoutes["cohort:import"];
		const result = (await importRoute.handler(
			buildRouteCtx(
				importRoute.input!.parse({
					cohortId: created.id,
					csv: "alice@x.com\nghost@x.com\n",
				}),
			),
		)) as { added: CohortMember[]; unknownEmails: string[] };
		expect(result.added).toHaveLength(1);
		expect(result.unknownEmails).toEqual(["ghost@x.com"]);
	});

	it("rejects payloads with neither emails nor csv at the schema layer", () => {
		const importRoute = cohortRoutes["cohort:import"];
		expect(() => importRoute.input!.parse({ cohortId: "x" })).toThrow();
	});

	it("does NOT auto-create unknown users (D50)", async () => {
		const { buildRouteCtx } = makeCtx({});
		const createRoute = cohortRoutes["cohort:create"];
		const created = (await createRoute.handler(
			buildRouteCtx(createRoute.input!.parse({ slug: "noauto", title: "NoAuto" })),
		)) as { id: string };
		const importRoute = cohortRoutes["cohort:import"];
		const result = (await importRoute.handler(
			buildRouteCtx(
				importRoute.input!.parse({
					cohortId: created.id,
					emails: ["unknown@x.com"],
				}),
			),
		)) as { added: CohortMember[]; unknownEmails: string[] };
		expect(result.added).toEqual([]);
		expect(result.unknownEmails).toEqual(["unknown@x.com"]);
	});
});

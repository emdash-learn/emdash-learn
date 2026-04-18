/**
 * Integration tests for the public catalog route (T17).
 *
 * Covers:
 *   - Happy path: only `published` courses surface, with pricing/currency.
 *   - Empty: no published courses returns `[]` + `hasMore: false`.
 *   - Difficulty filter.
 *   - Search filter (case-insensitive substring on title).
 *   - Pagination via `limit` + `cursor` round-trip.
 *   - Missing `ctx.content` → LEARN_SETUP_INCOMPLETE (status 500).
 *
 * `seed.ts` is intentionally untouched — the helper does not expose a
 * `status` hook, so tests publish courses by calling `handleContentPublish`
 * directly (same pattern as `tests/integration/engine/curriculum.test.ts`).
 */

import { afterEach, describe, expect, it } from "vitest";
import { handleContentPublish } from "emdash";
import type { PluginContext } from "emdash";

import { catalogRoutes } from "../../../src/routes/public-catalog.js";
import { LEARN_ERRORS } from "../../../src/constants.js";
import { seedCourse, type SeedCourseInput } from "../../utils/seed.js";
import { createTestPluginCtx, getTestDb } from "../../utils/test-plugin-ctx.js";

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

async function seedPublishedCourse(
	fixture: TestCtx,
	input: SeedCourseInput = {},
): Promise<{ id: string; title: string }> {
	const course = await seedCourse(fixture.ctx, input);
	await handleContentPublish(getTestDb(fixture.ctx), "courses", course.id);
	return { id: course.id, title: input.title ?? "Seed Course" };
}

function makeRouteCtx(fixture: TestCtx, input: unknown) {
	return { ...fixture.ctx, user: fixture.user, input };
}

interface CatalogResponse {
	items: Array<{
		id: string;
		title: string;
		difficulty?: string;
		priceCents?: number;
		currency?: string;
	}>;
	cursor?: string;
	hasMore: boolean;
}

async function runCatalog(
	fixture: TestCtx,
	input: Record<string, unknown> = {},
): Promise<CatalogResponse> {
	const route = catalogRoutes.catalog;
	// eslint-disable-next-line typescript-eslint/no-explicit-any
	const out = await route.handler(makeRouteCtx(fixture, input) as any);
	return out as CatalogResponse;
}

describe("routes/public-catalog", () => {
	it("returns only published courses with pricing + currency", async () => {
		const fixture = await newCtx();
		const a = await seedPublishedCourse(fixture, {
			title: "Alpha",
			priceCents: 4900,
			currency: "USD",
		});
		const b = await seedPublishedCourse(fixture, {
			title: "Beta",
			priceCents: 0,
			currency: "USD",
		});
		const c = await seedPublishedCourse(fixture, {
			title: "Gamma",
			priceCents: 9900,
			currency: "EUR",
		});
		// Unpublished draft — must NOT appear.
		await seedCourse(fixture.ctx, { title: "Draft" });

		const result = await runCatalog(fixture);
		expect(result.hasMore).toBe(false);
		expect(result.items).toHaveLength(3);

		const byId = new Map(result.items.map((i) => [i.id, i]));
		expect(byId.get(a.id)).toMatchObject({ title: "Alpha", priceCents: 4900, currency: "USD" });
		expect(byId.get(b.id)).toMatchObject({ title: "Beta", priceCents: 0, currency: "USD" });
		expect(byId.get(c.id)).toMatchObject({ title: "Gamma", priceCents: 9900, currency: "EUR" });
	});

	it("returns an empty page when no courses are published", async () => {
		const fixture = await newCtx();
		// A draft course should still leave the catalog empty.
		await seedCourse(fixture.ctx, { title: "Only Draft" });

		const result = await runCatalog(fixture);
		expect(result.items).toEqual([]);
		expect(result.hasMore).toBe(false);
		expect(result.cursor).toBeUndefined();
	});

	it("filters by difficulty", async () => {
		const fixture = await newCtx();
		const beginner = await seedPublishedCourse(fixture, {
			title: "Intro",
			difficulty: "beginner",
		});
		await seedPublishedCourse(fixture, { title: "Mid", difficulty: "intermediate" });
		await seedPublishedCourse(fixture, { title: "Pro", difficulty: "advanced" });

		const result = await runCatalog(fixture, { difficulty: "beginner" });
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.id).toBe(beginner.id);
		expect(result.items[0]?.difficulty).toBe("beginner");
	});

	it("filters by case-insensitive title search", async () => {
		const fixture = await newCtx();
		const react = await seedPublishedCourse(fixture, { title: "Intro to React" });
		await seedPublishedCourse(fixture, { title: "Advanced SQL" });

		const result = await runCatalog(fixture, { search: "react" });
		expect(result.items).toHaveLength(1);
		expect(result.items[0]?.id).toBe(react.id);
	});

	it("paginates with limit + cursor", async () => {
		const fixture = await newCtx();
		const ids = new Set<string>();
		for (let i = 0; i < 5; i += 1) {
			// eslint-disable-next-line no-await-in-loop
			const course = await seedPublishedCourse(fixture, { title: `Course ${i}` });
			ids.add(course.id);
		}

		const first = await runCatalog(fixture, { limit: 2 });
		expect(first.items).toHaveLength(2);
		expect(first.hasMore).toBe(true);
		expect(first.cursor).toBeDefined();

		const second = await runCatalog(fixture, {
			limit: 2,
			cursor: first.cursor,
		});
		expect(second.items.length).toBeGreaterThan(0);

		const seen = new Set<string>();
		for (const item of first.items) seen.add(item.id);
		for (const item of second.items) seen.add(item.id);
		// No overlap between pages.
		expect(seen.size).toBe(first.items.length + second.items.length);
		for (const id of seen) expect(ids.has(id)).toBe(true);
	});

	it("returns LEARN_SETUP_INCOMPLETE (status 500) when ctx.content is unavailable", async () => {
		const fixture = await newCtx();
		const stripped: PluginContext = { ...fixture.ctx };
		delete (stripped as { content?: unknown }).content;

		const route = catalogRoutes.catalog;
		await expect(
			// eslint-disable-next-line typescript-eslint/no-explicit-any
			route.handler({ ...stripped, user: fixture.user, input: {} } as any),
		).rejects.toMatchObject({
			name: "PluginRouteError",
			code: LEARN_ERRORS.SETUP_INCOMPLETE,
			status: 500,
		});
	});
});

/**
 * Public catalog route (T17 / §6.2).
 *
 *   catalog  { cursor?, limit?, difficulty?, search? }
 *            → { items: CatalogCourse[], cursor?, hasMore }
 *
 * No auth. Used by consumer Astro sites to render a storefront/catalog page.
 * Returns every published course in the `courses` content collection; the
 * theme decides paid-gate UI from the emitted `priceCents` / `currency`
 * fields (D22).
 *
 * `difficulty` and `search` are applied server-side across multiple upstream
 * pages so callers always get a full page of filtered results (M3). Upstream
 * pages are fetched in batches of `limit` until `limit` filtered items are
 * collected or upstream is exhausted (capped at MAX_UPSTREAM_PAGES to bound
 * worst-case latency for sparse filters). The cursor is synthetic: it encodes
 * the upstream position from which the next call should start.
 *
 * When filters are extremely sparse and the safety cap triggers, the returned
 * `hasMore=true` may be optimistic — subsequent pages may return fewer than
 * `limit` matches. A proper text index (§26, v1.1) will eliminate this edge
 * case entirely.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginContext, type PluginRoute } from "emdash";

import { COURSES_COLLECTION_SLUG, LEARN_ERRORS } from "../constants.js";
import type { ResultError } from "../engine/result.js";
import { ensureSetupComplete } from "../setup-gate.js";

export const catalogInput = z.object({
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(100).optional(),
	difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
	search: z.string().max(200).optional(),
});
export type CatalogInput = z.infer<typeof catalogInput>;

export interface CatalogCourse {
	id: string;
	slug?: string;
	title: string;
	subtitle?: string;
	description?: string;
	coverImage?: string;
	trailerUrl?: string;
	difficulty?: "beginner" | "intermediate" | "advanced";
	estimatedHours?: number;
	priceCents?: number;
	currency?: string;
	enrollmentOpen?: boolean;
	enrollmentOpensAt?: string;
	enrollmentClosesAt?: string;
	publishedAt?: string;
}

export interface CatalogPage {
	items: CatalogCourse[];
	cursor?: string;
	hasMore: boolean;
}

const MAX_UPSTREAM_PAGES = 10;

type SyntheticCursor = { uc?: string };

function decodeCatalogCursor(cursor: string | undefined): SyntheticCursor {
	if (!cursor) return {};
	try {
		return JSON.parse(atob(cursor)) as SyntheticCursor;
	} catch {
		return {};
	}
}

function encodeCatalogCursor(uc: string): string {
	return btoa(JSON.stringify({ uc } satisfies SyntheticCursor));
}

function statusForCode(code: string): number {
	if (code === LEARN_ERRORS.SETUP_INCOMPLETE) return 500;
	return 400;
}

function toRouteError(error: ResultError): PluginRouteError {
	return new PluginRouteError(error.code, error.message, statusForCode(error.code));
}

type RuntimeContentItem = NonNullable<
	Awaited<ReturnType<NonNullable<PluginContext["content"]>["get"]>>
>;

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined;
}

function asDifficulty(v: unknown): CatalogCourse["difficulty"] {
	if (v === "beginner" || v === "intermediate" || v === "advanced") return v;
	return undefined;
}

function toCatalogCourse(item: RuntimeContentItem): CatalogCourse {
	const data = item.data;
	const out: CatalogCourse = {
		id: item.id,
		title: asString(data["title"]) ?? "",
	};
	if (item.slug) out.slug = item.slug;
	const subtitle = asString(data["subtitle"]);
	if (subtitle !== undefined) out.subtitle = subtitle;
	const description = asString(data["description"]);
	if (description !== undefined) out.description = description;
	const coverImage = asString(data["cover_image"]);
	if (coverImage !== undefined) out.coverImage = coverImage;
	const trailerUrl = asString(data["trailer_url"]);
	if (trailerUrl !== undefined) out.trailerUrl = trailerUrl;
	const difficulty = asDifficulty(data["difficulty"]);
	if (difficulty !== undefined) out.difficulty = difficulty;
	const estimatedHours = asNumber(data["estimated_hours"]);
	if (estimatedHours !== undefined) out.estimatedHours = estimatedHours;
	const priceCents = asNumber(data["price_cents"]);
	if (priceCents !== undefined) out.priceCents = priceCents;
	const currency = asString(data["currency"]);
	if (currency !== undefined) out.currency = currency;
	const enrollmentOpen = asBoolean(data["enrollment_open"]);
	if (enrollmentOpen !== undefined) out.enrollmentOpen = enrollmentOpen;
	const enrollmentOpensAt = asString(data["enrollment_opens_at"]);
	if (enrollmentOpensAt !== undefined) out.enrollmentOpensAt = enrollmentOpensAt;
	const enrollmentClosesAt = asString(data["enrollment_closes_at"]);
	if (enrollmentClosesAt !== undefined) out.enrollmentClosesAt = enrollmentClosesAt;
	if (item.publishedAt) out.publishedAt = item.publishedAt;
	return out;
}

function matchesFilters(
	course: CatalogCourse,
	difficulty: CatalogInput["difficulty"],
	searchLower: string | undefined,
): boolean {
	if (difficulty !== undefined && course.difficulty !== difficulty) return false;
	if (searchLower !== undefined && !course.title.toLowerCase().includes(searchLower)) {
		return false;
	}
	return true;
}

const catalogRoute: PluginRoute<CatalogInput> = {
	input: catalogInput,
	// §6.2: catalog is open — theme/demo pages render it without a session.
	public: true,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		const content = ctx.content;
		if (!content) {
			throw toRouteError({
				code: LEARN_ERRORS.SETUP_INCOMPLETE,
				message:
					"Content access is unavailable on this plugin context — install + activate the plugin before serving the public catalog.",
			});
		}

		const { cursor, limit, difficulty, search } = ctx.input;
		const effectiveLimit = limit ?? 20;
		const searchLower = search?.toLowerCase();

		// Decode synthetic cursor → upstream cursor position.
		const { uc: startCursor } = decodeCatalogCursor(cursor);

		const collected: CatalogCourse[] = [];
		let nextUpstreamCursor: string | undefined = startCursor;
		let upstreamDone = false;

		// Loop upstream pages, accumulating filtered results up to effectiveLimit.
		// Upstream page size equals effectiveLimit to avoid over-fetching on the
		// last page (which would lose buffered matches without a within-page cursor).
		for (let i = 0; i < MAX_UPSTREAM_PAGES; i++) {
			const page = await content.list(COURSES_COLLECTION_SLUG, {
				where: { status: "published" },
				cursor: nextUpstreamCursor,
				limit: effectiveLimit,
			});

			const filtered = page.items
				.map(toCatalogCourse)
				.filter((c) => matchesFilters(c, difficulty, searchLower));
			collected.push(...filtered);

			if (page.cursor) nextUpstreamCursor = page.cursor;

			if (!page.hasMore) {
				upstreamDone = true;
				break;
			}
			if (collected.length >= effectiveLimit) break;
		}

		const items = collected.slice(0, effectiveLimit);
		const hasMore = !upstreamDone;

		const result: CatalogPage = { items, hasMore };
		if (hasMore && nextUpstreamCursor) result.cursor = encodeCatalogCursor(nextUpstreamCursor);
		return result;
	},
};

export const catalogRoutes = {
	catalog: catalogRoute,
} as const;

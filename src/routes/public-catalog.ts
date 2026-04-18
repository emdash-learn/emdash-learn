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
 * `difficulty` and `search` are applied client-side after pulling a page from
 * `ctx.content.list` — the content API's `where` clause does not index those
 * fields today. Server-side filters are tracked in §26 as a v1.1
 * optimization. Because filters are applied after pagination, `hasMore` is
 * reported from the underlying page (not from the filtered result): clients
 * keep paging the upstream cursor until `hasMore === false`.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginContext, type PluginRoute } from "emdash";

import { COURSES_COLLECTION_SLUG, LEARN_ERRORS } from "../constants.js";
import type { ResultError } from "../engine/result.js";

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
	handler: async (ctx) => {
		const content = ctx.content;
		if (!content) {
			throw toRouteError({
				code: LEARN_ERRORS.SETUP_INCOMPLETE,
				message:
					"Content access is unavailable on this plugin context — install + activate the plugin before serving the public catalog.",
			});
		}

		const { cursor, limit, difficulty, search } = ctx.input;
		const listOpts: { where: { status: "published" }; cursor?: string; limit?: number } = {
			where: { status: "published" },
		};
		if (cursor !== undefined) listOpts.cursor = cursor;
		if (limit !== undefined) listOpts.limit = limit;

		const page = await content.list(COURSES_COLLECTION_SLUG, listOpts);
		const searchLower = search?.toLowerCase();

		const items = page.items
			.map(toCatalogCourse)
			.filter((c) => matchesFilters(c, difficulty, searchLower));

		const result: CatalogPage = { items, hasMore: page.hasMore };
		if (page.hasMore && page.cursor !== undefined) result.cursor = page.cursor;
		return result;
	},
};

export const catalogRoutes = {
	catalog: catalogRoute,
} as const;

/**
 * Instructor topic routes (ADR 0001).
 *
 * Six POST endpoints, all `EDITOR`-gated:
 *   - topic:list     { lessonId? | courseId?, cursor?, limit? }
 *   - topic:get      { topicId }
 *   - topic:create   { lessonId, courseId, order, title, body?, summary?,
 *                      videoUrl?, durationSeconds?, requiresPrevious? }
 *   - topic:update   { topicId, ...(any field) }
 *   - topic:delete   { topicId }
 *   - topic:reorder  { lessonId, topicIds: string[] }
 *
 * Topic CRUD goes through `ctx.content.create/update/remove` against the
 * `topics` content collection (provisioned by the setup wizard). The engine
 * delegates lesson/topic invariants to the schema layer; this route module
 * is the thin authz/transport boundary.
 *
 * Authoring uses the same EDITOR role as lesson authoring; per-course
 * instructor scoping is left to the per-course routes (analytics, progress
 * matrix). Authoring routes here grant the same CMS-wide write that lesson
 * authoring has.
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute, type RouteContext } from "emdash";

import { Role, requireRole } from "../authz.js";
import { LEARN_ERRORS, TOPICS_COLLECTION_SLUG } from "../constants.js";
import { ensureSetupComplete } from "../setup-gate.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const topicListInput = z
	.object({
		lessonId: z.string().min(1).optional(),
		courseId: z.string().min(1).optional(),
		cursor: z.string().optional(),
		limit: z.number().int().min(1).max(100).optional(),
	})
	.refine(
		(v) => Boolean(v.lessonId) || Boolean(v.courseId) || (!v.lessonId && !v.courseId),
		"`lessonId` and `courseId` are mutually exclusive",
	);
export type TopicListInput = z.infer<typeof topicListInput>;

export const topicGetInput = z.object({ topicId: z.string().min(1) });
export type TopicGetInput = z.infer<typeof topicGetInput>;

const portableTextBlock = z.record(z.string(), z.unknown());

export const topicCreateInput = z.object({
	lessonId: z.string().min(1),
	courseId: z.string().min(1),
	order: z.number().int().nonnegative().default(0),
	title: z.string().min(1).max(200),
	summary: z.string().max(500).optional(),
	body: z.array(portableTextBlock).optional(),
	videoUrl: z.string().max(500).optional(),
	durationSeconds: z.number().int().nonnegative().optional(),
	requiresPrevious: z.boolean().optional(),
	slug: z
		.string()
		.regex(/^[a-z0-9][a-z0-9-]*$/, "slug must be lowercase alphanumeric with dashes")
		.max(120)
		.optional(),
	status: z.enum(["draft", "published"]).default("draft"),
});
export type TopicCreateInput = z.infer<typeof topicCreateInput>;

export const topicUpdateInput = z.object({
	topicId: z.string().min(1),
	lessonId: z.string().min(1).optional(),
	courseId: z.string().min(1).optional(),
	order: z.number().int().nonnegative().optional(),
	title: z.string().min(1).max(200).optional(),
	summary: z.string().max(500).optional(),
	body: z.array(portableTextBlock).optional(),
	videoUrl: z.string().max(500).optional(),
	durationSeconds: z.number().int().nonnegative().optional(),
	requiresPrevious: z.boolean().optional(),
	status: z.enum(["draft", "published"]).optional(),
});
export type TopicUpdateInput = z.infer<typeof topicUpdateInput>;

export const topicDeleteInput = z.object({ topicId: z.string().min(1) });
export type TopicDeleteInput = z.infer<typeof topicDeleteInput>;

export const topicReorderInput = z.object({
	lessonId: z.string().min(1),
	topicIds: z.array(z.string().min(1)).min(1).max(500),
});
export type TopicReorderInput = z.infer<typeof topicReorderInput>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gateInstructor(ctx: RouteContext): void {
	const user = requireRole(ctx, Role.EDITOR);
	if (!user.ok) {
		throw new PluginRouteError(
			user.error.code,
			user.error.message,
			user.error.code === LEARN_ERRORS.UNAUTHENTICATED ? 401 : 403,
		);
	}
}

interface ContentItem {
	id: string;
	slug?: string | null;
	status?: string;
	publishedAt?: string | null;
	data: Record<string, unknown>;
}

function requireContent(ctx: { content?: unknown }): {
	get: (collection: string, id: string) => Promise<ContentItem | null>;
	list: (
		collection: string,
		opts?: { where?: Record<string, unknown>; limit?: number; cursor?: string },
	) => Promise<{ items: ContentItem[]; cursor?: string; hasMore: boolean }>;
	create: (collection: string, data: Record<string, unknown>) => Promise<ContentItem>;
	update: (collection: string, id: string, patch: Record<string, unknown>) => Promise<ContentItem>;
	remove?: (collection: string, id: string) => Promise<void>;
	delete?: (collection: string, id: string) => Promise<void>;
} {
	const c = ctx.content;
	if (!c) {
		throw new PluginRouteError(
			LEARN_ERRORS.SETUP_INCOMPLETE,
			"content access is not available — run the setup wizard.",
			409,
		);
	}
	// eslint-disable-next-line typescript-eslint/no-explicit-any -- emdash content surface
	return c as any;
}

function topicSummary(item: ContentItem): {
	id: string;
	slug?: string | null;
	status?: string;
	publishedAt?: string | null;
	lessonId?: string;
	courseId?: string;
	order?: number;
	title?: string;
} {
	const data = item.data;
	const out: ReturnType<typeof topicSummary> = {
		id: item.id,
	};
	if (item.slug !== undefined) out.slug = item.slug;
	if (item.status !== undefined) out.status = item.status;
	if (item.publishedAt !== undefined) out.publishedAt = item.publishedAt;
	const lessonId = data["lesson"];
	if (typeof lessonId === "string") out.lessonId = lessonId;
	const courseId = data["course"];
	if (typeof courseId === "string") out.courseId = courseId;
	const order = data["order"];
	if (typeof order === "number") out.order = order;
	const title = data["title"];
	if (typeof title === "string") out.title = title;
	return out;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listRoute: PluginRoute<TopicListInput> = {
	input: topicListInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		gateInstructor(ctx);
		const content = requireContent(ctx);
		const limit = ctx.input.limit ?? 50;
		const where: Record<string, unknown> = { status: "published" };
		const opts: { limit: number; where: Record<string, unknown>; cursor?: string } = {
			limit,
			where,
		};
		if (ctx.input.cursor !== undefined) opts.cursor = ctx.input.cursor;
		// emdash content list does not support filtering by reference fields
		// server-side; we paginate published items and filter client-side.
		// Same approach as the curriculum engine.
		const out: ReturnType<typeof topicSummary>[] = [];
		let cursor: string | undefined = ctx.input.cursor;
		// oxlint-disable no-await-in-loop
		while (out.length < limit) {
			const pageOpts: { limit: number; where: Record<string, unknown>; cursor?: string } = {
				limit: 100,
				where,
			};
			if (cursor !== undefined) pageOpts.cursor = cursor;
			const page = await content.list(TOPICS_COLLECTION_SLUG, pageOpts);
			for (const item of page.items) {
				if (out.length >= limit) break;
				if (ctx.input.lessonId && item.data["lesson"] !== ctx.input.lessonId) continue;
				if (ctx.input.courseId && item.data["course"] !== ctx.input.courseId) continue;
				out.push(topicSummary(item));
			}
			if (!page.hasMore) {
				cursor = undefined;
				break;
			}
			cursor = page.cursor;
		}
		// oxlint-enable no-await-in-loop
		return { items: out, cursor, hasMore: cursor !== undefined };
	},
};

const getRoute: PluginRoute<TopicGetInput> = {
	input: topicGetInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		gateInstructor(ctx);
		const content = requireContent(ctx);
		const item = await content.get(TOPICS_COLLECTION_SLUG, ctx.input.topicId);
		if (!item) {
			throw new PluginRouteError(
				LEARN_ERRORS.TOPIC_LOCKED,
				`Topic ${ctx.input.topicId} not found`,
				404,
			);
		}
		return { topic: item };
	},
};

const createRoute: PluginRoute<TopicCreateInput> = {
	input: topicCreateInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		gateInstructor(ctx);
		const content = requireContent(ctx);
		const data: Record<string, unknown> = {
			title: ctx.input.title,
			lesson: ctx.input.lessonId,
			course: ctx.input.courseId,
			order: ctx.input.order,
		};
		if (ctx.input.summary !== undefined) data.summary = ctx.input.summary;
		if (ctx.input.body !== undefined) data.body = ctx.input.body;
		if (ctx.input.videoUrl !== undefined) data.video_url = ctx.input.videoUrl;
		if (ctx.input.durationSeconds !== undefined) data.duration_seconds = ctx.input.durationSeconds;
		if (ctx.input.requiresPrevious !== undefined)
			data.requires_previous = ctx.input.requiresPrevious;
		const payload: Record<string, unknown> = { type: TOPICS_COLLECTION_SLUG, data };
		if (ctx.input.slug) payload.slug = ctx.input.slug;
		payload.status = ctx.input.status;
		if (ctx.input.status === "published") {
			payload.publishedAt = new Date().toISOString();
		}
		// eslint-disable-next-line typescript-eslint/no-explicit-any -- emdash content.create accepts a single payload object
		const item = await (content as any).create(payload);
		return { topic: item };
	},
};

const updateRoute: PluginRoute<TopicUpdateInput> = {
	input: topicUpdateInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		gateInstructor(ctx);
		const content = requireContent(ctx);
		const existing = await content.get(TOPICS_COLLECTION_SLUG, ctx.input.topicId);
		if (!existing) {
			throw new PluginRouteError(
				LEARN_ERRORS.TOPIC_LOCKED,
				`Topic ${ctx.input.topicId} not found`,
				404,
			);
		}
		const data: Record<string, unknown> = { ...existing.data };
		if (ctx.input.title !== undefined) data.title = ctx.input.title;
		if (ctx.input.lessonId !== undefined) data.lesson = ctx.input.lessonId;
		if (ctx.input.courseId !== undefined) data.course = ctx.input.courseId;
		if (ctx.input.order !== undefined) data.order = ctx.input.order;
		if (ctx.input.summary !== undefined) data.summary = ctx.input.summary;
		if (ctx.input.body !== undefined) data.body = ctx.input.body;
		if (ctx.input.videoUrl !== undefined) data.video_url = ctx.input.videoUrl;
		if (ctx.input.durationSeconds !== undefined) data.duration_seconds = ctx.input.durationSeconds;
		if (ctx.input.requiresPrevious !== undefined)
			data.requires_previous = ctx.input.requiresPrevious;
		const patch: Record<string, unknown> = { data };
		if (ctx.input.status !== undefined) {
			patch.status = ctx.input.status;
			if (ctx.input.status === "published" && !existing.publishedAt) {
				patch.publishedAt = new Date().toISOString();
			}
		}
		const item = await content.update(TOPICS_COLLECTION_SLUG, ctx.input.topicId, patch);
		return { topic: item };
	},
};

const deleteRoute: PluginRoute<TopicDeleteInput> = {
	input: topicDeleteInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		gateInstructor(ctx);
		const content = requireContent(ctx);
		const fn = content.remove ?? content.delete;
		if (!fn) {
			throw new PluginRouteError(
				LEARN_ERRORS.SETUP_INCOMPLETE,
				"content delete is not available",
				409,
			);
		}
		await fn.call(content, TOPICS_COLLECTION_SLUG, ctx.input.topicId);
		return { ok: true };
	},
};

const reorderRoute: PluginRoute<TopicReorderInput> = {
	input: topicReorderInput,
	handler: async (ctx) => {
		await ensureSetupComplete(ctx);
		gateInstructor(ctx);
		const content = requireContent(ctx);
		// Iterate the supplied order. Skip topics that don't belong to the
		// specified lesson — the client may have cached a stale list.
		const updates: ContentItem[] = [];
		for (let i = 0; i < ctx.input.topicIds.length; i++) {
			const id = ctx.input.topicIds[i]!;
			// eslint-disable-next-line no-await-in-loop
			const existing = await content.get(TOPICS_COLLECTION_SLUG, id);
			if (!existing) continue;
			if (existing.data["lesson"] !== ctx.input.lessonId) continue;
			const data = { ...existing.data, order: i };
			// eslint-disable-next-line no-await-in-loop
			const item = await content.update(TOPICS_COLLECTION_SLUG, id, { data });
			updates.push(item);
		}
		return { reordered: updates.map((u) => topicSummary(u)) };
	},
};

export const instructorTopicRoutes = {
	"topic:list": listRoute,
	"topic:get": getRoute,
	"topic:create": createRoute,
	"topic:update": updateRoute,
	"topic:delete": deleteRoute,
	"topic:reorder": reorderRoute,
} as const;

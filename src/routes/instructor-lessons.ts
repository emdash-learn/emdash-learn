/**
 * Instructor lesson read route (ADR 0001 follow-up).
 *
 * One POST endpoint, `EDITOR`-gated:
 *   - lesson:list  { courseId, cursor?, limit? }
 *
 * Read-only mirror of `instructor-topics.ts`'s list pattern. Lesson CRUD
 * still flows through the emdash content editor — this route exists so the
 * admin Curriculum tab can show lessons that have zero topics (the topic-
 * list grouping alone misses them) and resolve real lesson titles instead
 * of raw IDs.
 *
 * Filtering by `course === courseId` happens client-side because the emdash
 * content surface does not support filtering by reference fields server-
 * side (same approach as the engine's `listLessonsForCourse`).
 */

import { z } from "astro/zod";
import { PluginRouteError, type PluginRoute } from "emdash";

import { type AuthContext, Role, requireRole } from "../authz.js";
import { LEARN_ERRORS, LESSONS_COLLECTION_SLUG } from "../constants.js";

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const lessonListInput = z.object({
	courseId: z.string().min(1),
	cursor: z.string().optional(),
	limit: z.number().int().min(1).max(100).optional(),
});
export type LessonListInput = z.infer<typeof lessonListInput>;

// ---------------------------------------------------------------------------
// Helpers (mirror instructor-topics.ts)
// ---------------------------------------------------------------------------

function gateInstructor(ctx: unknown): void {
	const auth = ctx as AuthContext;
	const user = requireRole(auth, Role.EDITOR);
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
	list: (
		collection: string,
		opts?: { where?: Record<string, unknown>; limit?: number; cursor?: string },
	) => Promise<{ items: ContentItem[]; cursor?: string; hasMore: boolean }>;
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

export interface LessonSummary {
	id: string;
	slug?: string | null;
	status?: string;
	title?: string;
	order?: number;
	courseId?: string;
	isPreview?: boolean;
}

function lessonSummary(item: ContentItem): LessonSummary {
	const data = item.data;
	const out: LessonSummary = { id: item.id };
	if (item.slug !== undefined) out.slug = item.slug;
	if (item.status !== undefined) out.status = item.status;
	const title = data["title"];
	if (typeof title === "string") out.title = title;
	const order = data["order"];
	if (typeof order === "number") out.order = order;
	const courseId = data["course"];
	if (typeof courseId === "string") out.courseId = courseId;
	const isPreview = data["is_preview"];
	if (isPreview === true || isPreview === 1) out.isPreview = true;
	else if (isPreview === false || isPreview === 0) out.isPreview = false;
	return out;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const listRoute: PluginRoute<LessonListInput> = {
	input: lessonListInput,
	handler: async (ctx) => {
		gateInstructor(ctx);
		const content = requireContent(ctx);
		const limit = ctx.input.limit ?? 50;
		const where: Record<string, unknown> = { status: "published" };
		// Mirror instructor-topics.ts + engine listLessonsForCourse: emdash
		// content list cannot filter by reference fields server-side; paginate
		// published items and filter client-side.
		const out: LessonSummary[] = [];
		let cursor: string | undefined = ctx.input.cursor;
		// oxlint-disable no-await-in-loop
		while (out.length < limit) {
			const pageOpts: { limit: number; where: Record<string, unknown>; cursor?: string } = {
				limit: 100,
				where,
			};
			if (cursor !== undefined) pageOpts.cursor = cursor;
			const page = await content.list(LESSONS_COLLECTION_SLUG, pageOpts);
			for (const item of page.items) {
				if (out.length >= limit) break;
				if (item.data["course"] !== ctx.input.courseId) continue;
				out.push(lessonSummary(item));
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

export const instructorLessonRoutes = {
	"lesson:list": listRoute,
} as const;

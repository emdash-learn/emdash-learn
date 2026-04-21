/**
 * Read-only mirrors of the Course and Lesson content collections (§5.1 / §5.2).
 * These are NOT the full `ContentItem` emdash returns — they're the
 * engine-facing projection of `content.item.data[fieldSlug]` merged with the
 * top-level metadata the engine actually reads.
 *
 * Convention: 🔒 frozen fields (§4.4) are required; non-frozen fields are
 * optional since an admin may add, remove, or rename them freely after the
 * wizard provisions the collection.
 */

import type { PortableTextBlock } from "emdash";

export type CourseDifficulty = "beginner" | "intermediate" | "advanced";

export interface CourseRow {
	/** Emdash content-item id. Always present; not a schema field. */
	id: string;
	/** Content-item slug ("/courses/{slug}"). `null` when unpublished without a slug. */
	slug: string | null;
	/** Content-item status ("draft" | "published" | "scheduled" | "trashed"). */
	status: string;
	/** Content-item `publishedAt` timestamp, if any. */
	publishedAt: string | null;

	// --- Frozen, engine-depended fields (🔒 in §5.1) ---
	/** 🔒 `title` — required. */
	title: string;
	/** 🔒 `enrollment_open` — always present (default `true`). */
	enrollmentOpen: boolean;
	/** 🔒 `enrollment_opens_at` — optional ISO datetime. */
	enrollmentOpensAt?: string;
	/** 🔒 `enrollment_closes_at` — optional ISO datetime. */
	enrollmentClosesAt?: string;

	// --- Non-frozen fields admins may add/remove/rename (§4.4) ---
	subtitle?: string;
	description?: string;
	body?: PortableTextBlock[];
	coverImage?: string;
	trailerUrl?: string;
	difficulty?: CourseDifficulty;
	estimatedHours?: number;
	priceCents?: number;
	currency?: string;
}

export interface LessonRow {
	/** Emdash content-item id. */
	id: string;
	/** Content-item slug ("/lessons/{slug}"). */
	slug: string | null;
	/** Content-item status. */
	status: string;
	/** Content-item `publishedAt` timestamp, if any. */
	publishedAt: string | null;
	/** Content-item `scheduledAt` timestamp, if the item is scheduled. */
	scheduledAt?: string | null;

	// --- Frozen, engine-depended fields (🔒 in §5.2) ---
	/** 🔒 `title` — required. */
	title: string;
	/** 🔒 `course` reference — required; resolved to the referenced course id. */
	courseId: string;
	/** 🔒 `order` — required (default `0`); lesson sequence within a course. */
	order: number;
	/** 🔒 `duration_seconds` — always present (default `0`). */
	durationSeconds: number;
	/** 🔒 `is_preview` — always present (default `false`). */
	isPreview: boolean;
	/** 🔒 `requires_previous` — always present (default `false`). */
	requiresPrevious: boolean;
	/** 🔒 `drip_offset_days` — always present (default `0`). */
	dripOffsetDays: number;

	// --- Non-frozen fields admins may add/remove/rename (§4.4) ---
	summary?: string;
	body?: PortableTextBlock[];
	videoUrl?: string;
	/** Quiz ID attached to this lesson for the terminal-quiz gate (H2). Stored under key `"quiz"`. */
	quiz?: string;
}

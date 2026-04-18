/**
 * Read-only mirrors of the Course and Lesson content collections (§5.1 / §5.2).
 * These are NOT the full `ContentItem` emdash returns — they're the
 * engine-facing projection of `content.item.data[fieldSlug]` merged with the
 * top-level metadata the engine actually reads.
 */

import type { PortableTextBlock } from "emdash";

export type CourseDifficulty = "beginner" | "intermediate" | "advanced";

export interface CourseRow {
	id: string;
	slug: string | null;
	status: string;
	title: string;
	subtitle?: string;
	description?: string;
	body?: PortableTextBlock[];
	coverImage?: string;
	trailerUrl?: string;
	difficulty: CourseDifficulty;
	estimatedHours?: number;
	priceCents: number;
	currency: string;
	enrollmentOpen: boolean;
	enrollmentOpensAt?: string;
	enrollmentClosesAt?: string;
	publishedAt: string | null;
}

export interface LessonRow {
	id: string;
	slug: string | null;
	status: string;
	title: string;
	courseId: string;
	order: number;
	summary?: string;
	body?: PortableTextBlock[];
	videoUrl?: string;
	durationSeconds: number;
	isPreview: boolean;
	requiresPrevious: boolean;
	dripOffsetDays: number;
	scheduledAt?: string | null;
	publishedAt: string | null;
}

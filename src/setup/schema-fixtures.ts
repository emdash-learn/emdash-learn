/**
 * Frozen schema specs the setup wizard (§7) provisions into emdash's content
 * registry. Source of truth for §5.1 (courses) and §5.2 (lessons).
 *
 * Reconciliation notes from emdash source (`packages/core/src/api/schemas/schema.ts`):
 *   - `supports` does not accept `"seo"` — SEO is on/off via the `hasSeo`
 *     flag, not a support entry. The PRD's mention of `"seo"` in supports is
 *     a drafting error; we send `hasSeo: true` instead.
 *   - `createCollectionBody` does not accept `commentsEnabled` or
 *     `commentsModeration`. We set them via a follow-up `PUT` in step 2/4.
 */

import type {
	CreateCollectionInput,
	CreateFieldInput,
	UpdateCollectionInput,
} from "emdash";

import { COURSES_COLLECTION_SLUG, LESSONS_COLLECTION_SLUG } from "../constants.js";

/**
 * A field spec as the wizard carries it: the emdash `CreateFieldInput` plus a
 * `locked` flag marking engine-depended fields (🔒 in the PRD). Rename
 * detection surfaces a repair prompt when a locked field disappears and cannot
 * be explained by a known rename.
 */
export interface FieldSpec extends CreateFieldInput {
	locked: boolean;
}

export interface CollectionFixture {
	create: CreateCollectionInput;
	/** Settings that must be applied via PUT after creation (see reconciliation note above). */
	postCreateUpdate?: UpdateCollectionInput;
	fields: FieldSpec[];
}

const coursesFields: FieldSpec[] = [
	{
		slug: "title",
		label: "Title",
		type: "string",
		required: true,
		validation: { maxLength: 200 },
		locked: true,
	},
	{
		slug: "subtitle",
		label: "Subtitle",
		type: "string",
		validation: { maxLength: 300 },
		locked: false,
	},
	{
		slug: "description",
		label: "Description",
		type: "text",
		validation: { maxLength: 1000 },
		widget: "textarea",
		locked: false,
	},
	{
		slug: "body",
		label: "Body",
		type: "portableText",
		locked: false,
	},
	{
		slug: "cover_image",
		label: "Cover image",
		type: "image",
		locked: false,
	},
	{
		slug: "trailer_url",
		label: "Trailer URL",
		type: "string",
		validation: { maxLength: 500 },
		locked: false,
	},
	{
		slug: "difficulty",
		label: "Difficulty",
		type: "select",
		defaultValue: "beginner",
		validation: { options: ["beginner", "intermediate", "advanced"] },
		locked: false,
	},
	{
		slug: "estimated_hours",
		label: "Estimated hours",
		type: "number",
		validation: { min: 0 },
		locked: false,
	},
	{
		slug: "price_cents",
		label: "Price (cents)",
		type: "integer",
		defaultValue: 0,
		validation: { min: 0 },
		locked: false,
	},
	{
		slug: "currency",
		label: "Currency",
		type: "string",
		defaultValue: "USD",
		validation: { pattern: "^[A-Z]{3}$" },
		locked: false,
	},
	{
		slug: "enrollment_open",
		label: "Enrollment open",
		type: "boolean",
		defaultValue: true,
		locked: true,
	},
	{
		slug: "enrollment_opens_at",
		label: "Enrollment opens at",
		type: "datetime",
		locked: true,
	},
	{
		slug: "enrollment_closes_at",
		label: "Enrollment closes at",
		type: "datetime",
		locked: true,
	},
];

const lessonsFields: FieldSpec[] = [
	{
		slug: "title",
		label: "Title",
		type: "string",
		required: true,
		validation: { maxLength: 200 },
		locked: true,
	},
	{
		slug: "course",
		label: "Course",
		type: "reference",
		required: true,
		options: { collection: COURSES_COLLECTION_SLUG, allowMultiple: false },
		locked: true,
	},
	{
		slug: "order",
		label: "Order",
		type: "integer",
		required: true,
		defaultValue: 0,
		validation: { min: 0 },
		locked: true,
	},
	{
		slug: "summary",
		label: "Summary",
		type: "text",
		validation: { maxLength: 500 },
		locked: false,
	},
	{
		slug: "body",
		label: "Body",
		type: "portableText",
		locked: false,
	},
	{
		slug: "video_url",
		label: "Video URL",
		type: "string",
		validation: { maxLength: 500 },
		locked: false,
	},
	{
		slug: "duration_seconds",
		label: "Duration (seconds)",
		type: "integer",
		defaultValue: 0,
		validation: { min: 0 },
		locked: true,
	},
	{
		slug: "is_preview",
		label: "Preview",
		type: "boolean",
		defaultValue: false,
		locked: true,
	},
	{
		slug: "requires_previous",
		label: "Requires previous lesson",
		type: "boolean",
		defaultValue: false,
		locked: true,
	},
	{
		slug: "drip_offset_days",
		label: "Drip offset (days)",
		type: "integer",
		defaultValue: 0,
		locked: true,
	},
];

export const COURSES_FIXTURE: CollectionFixture = {
	create: {
		slug: COURSES_COLLECTION_SLUG,
		label: "Courses",
		labelSingular: "Course",
		icon: "graduation-cap",
		supports: ["drafts", "revisions", "scheduling", "search"],
		urlPattern: "/courses/{slug}",
		hasSeo: true,
		source: `template:${COURSES_COLLECTION_SLUG}`,
	},
	postCreateUpdate: {
		commentsEnabled: false,
	},
	fields: coursesFields,
};

export const LESSONS_FIXTURE: CollectionFixture = {
	create: {
		slug: LESSONS_COLLECTION_SLUG,
		label: "Lessons",
		labelSingular: "Lesson",
		icon: "play-circle",
		supports: ["drafts", "revisions", "scheduling", "search"],
		urlPattern: "/lessons/{slug}",
		hasSeo: true,
		source: `template:${LESSONS_COLLECTION_SLUG}`,
	},
	postCreateUpdate: {
		commentsEnabled: true,
		commentsModeration: "first_time",
	},
	fields: lessonsFields,
};

export const FIXTURES = {
	courses: COURSES_FIXTURE,
	lessons: LESSONS_FIXTURE,
} as const;

export type FixtureKey = keyof typeof FIXTURES;

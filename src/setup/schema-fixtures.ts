/**
 * Frozen schema specs the setup wizard provisions into emdash's content
 * registry. This is the authoritative Course → Lesson content contract.
 *
 * Reconciliation note from emdash source
 * (`packages/core/src/api/schemas/schema.ts`): `supports` does not accept
 * `"seo"` — SEO is on/off via the `hasSeo` flag.
 */

import type { CreateCollectionInput, CreateFieldInput } from "emdash";

import { COURSES_COLLECTION_SLUG, LESSONS_COLLECTION_SLUG } from "../constants.js";

/**
 * A field spec as the wizard carries it: the emdash `CreateFieldInput` plus a
 * `locked` flag marking engine-dependent fields. Rename
 * detection surfaces a repair prompt when a locked field disappears and cannot
 * be explained by a known rename.
 */
export interface FieldSpec extends CreateFieldInput {
	locked: boolean;
}

export interface CollectionFixture {
	create: CreateCollectionInput;
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
	fields: lessonsFields,
};

export const FIXTURES = {
	courses: COURSES_FIXTURE,
	lessons: LESSONS_FIXTURE,
} as const;

export type FixtureKey = keyof typeof FIXTURES;

/**
 * Seed the reduced EmDash Learn demo.
 *
 * The fixture is deliberately anonymous: Course → Lesson content plus one
 * published Knowledge Check. It creates no users, roles, server Learning
 * Records, Attempts, or other legacy LMS records.
 *
 * Run with: `pnpm --filter ./demos/simple seed`
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";
import { ContentRepository, SchemaRegistry } from "emdash";
import type { CreateFieldInput, Database } from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely, SqliteDialect } from "kysely";

const PLUGIN_ID = "lms-core";
const BOOTSTRAP_VERSION = 4;
const SETUP_STATE_KEY = `plugin:${PLUGIN_ID}:state:bootstrap`;
const DIGEST_SECRET_KEY = `plugin:${PLUGIN_ID}:state:digest-secret:v1`;
const DEMO_DIGEST_SECRET = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KNOWLEDGE_CHECK_ID = "check_demo_publishing_basics";
const KNOWLEDGE_CHECK_REVISION_ID = "revision_demo_publishing_basics_v1";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = resolve(SCRIPT_DIR, "..");
const DB_PATH = process.env.EMDASH_LEARN_DEMO_DB
	? resolve(process.env.EMDASH_LEARN_DEMO_DB)
	: resolve(DEMO_ROOT, "data.db");

type FieldDef = Omit<CreateFieldInput, "sortOrder">;

const COURSE_FIELDS: FieldDef[] = [
	{ slug: "title", label: "Title", type: "string", required: true, validation: { maxLength: 200 } },
	{ slug: "subtitle", label: "Subtitle", type: "string", validation: { maxLength: 300 } },
	{
		slug: "description",
		label: "Description",
		type: "text",
		validation: { maxLength: 1000 },
		widget: "textarea",
	},
	{ slug: "body", label: "Body", type: "portableText" },
	{ slug: "cover_image", label: "Cover image", type: "image" },
	{
		slug: "difficulty",
		label: "Difficulty",
		type: "select",
		defaultValue: "beginner",
		validation: { options: ["beginner", "intermediate", "advanced"] },
	},
	{ slug: "estimated_hours", label: "Estimated hours", type: "number", validation: { min: 0 } },
];

const LESSON_FIELDS: FieldDef[] = [
	{ slug: "title", label: "Title", type: "string", required: true, validation: { maxLength: 200 } },
	{
		slug: "course",
		label: "Course",
		type: "reference",
		required: true,
		options: { collection: "courses", allowMultiple: false },
	},
	{
		slug: "order",
		label: "Order",
		type: "integer",
		required: true,
		defaultValue: 0,
		validation: { min: 0 },
	},
	{ slug: "summary", label: "Summary", type: "text", validation: { maxLength: 500 } },
	{ slug: "body", label: "Body", type: "portableText" },
	{ slug: "video_url", label: "Video URL", type: "string", validation: { maxLength: 500 } },
	{
		slug: "duration_seconds",
		label: "Duration (seconds)",
		type: "integer",
		defaultValue: 0,
		validation: { min: 0 },
	},
];

const SUPERSEDED_COURSE_FIELDS = [
	"trailer_url",
	"price_cents",
	"currency",
	"enrollment_open",
	"enrollment_opens_at",
	"enrollment_closes_at",
] as const;
const SUPERSEDED_LESSON_FIELDS = ["is_preview", "requires_previous", "drip_offset_days"] as const;

const LEGACY_COURSE_SLUGS = [
	"getting-started-with-react",
	"advanced-sql",
	"shipping-soon-course",
	"scheduled-drop",
];

const LEGACY_LESSON_SLUGS = [
	"react-intro",
	"react-setup",
	"react-components",
	"react-state",
	"react-effects",
	"react-deploy",
	"sql-window",
	"sql-ctes",
	"sql-plans",
	"sql-tuning",
	"shipping-soon-1",
	"shipping-soon-2",
	"shipping-soon-3",
	"scheduled-lesson-one",
];

const SEEDED_COURSE_SLUGS = [
	"course-publishing-essentials",
	"course-design-lab",
	"unpublished-course-draft",
];

const SEEDED_LESSON_SLUGS = [
	"shape-a-course",
	"publish-with-confidence",
	"draft-lesson-not-public",
	"design-a-learning-path",
];

async function ensureCollection(
	registry: SchemaRegistry,
	slug: string,
	label: string,
	labelSingular: string,
	icon: string,
	fields: FieldDef[],
): Promise<void> {
	const existing = await registry.getCollection(slug);
	if (!existing) {
		await registry.createCollection({
			slug,
			label,
			labelSingular,
			icon,
			supports: ["drafts", "revisions", "scheduling", "search"],
			urlPattern: `/${slug}/{slug}`,
			hasSeo: true,
			source: `template:${slug}`,
		});
	}

	const remote = await registry.getCollectionWithFields(slug);
	if (!remote) throw new Error(`Collection ${slug} missing after creation`);
	const existingFields = new Set(remote.fields.map((field) => field.slug));
	let sortOrder = remote.fields.length;
	/* oxlint-disable no-await-in-loop -- schema fields have a stable sequential sort order */
	for (const field of fields) {
		if (existingFields.has(field.slug)) continue;
		await registry.createField(slug, { ...field, sortOrder });
		sortOrder += 1;
	}
	/* oxlint-enable no-await-in-loop */
}

async function removeSupersededDemoSchema(registry: SchemaRegistry): Promise<void> {
	/* oxlint-disable no-await-in-loop -- deterministic one-time demo-schema cleanup */
	for (const field of SUPERSEDED_COURSE_FIELDS) {
		if (await registry.getField("courses", field)) {
			await registry.deleteField("courses", field);
		}
	}
	for (const field of SUPERSEDED_LESSON_FIELDS) {
		if (await registry.getField("lessons", field)) {
			await registry.deleteField("lessons", field);
		}
	}
	if (await registry.getCollection("topics")) {
		await registry.deleteCollection("topics", { force: true });
	}
	/* oxlint-enable no-await-in-loop */
}

function tableExists(sqlite: BetterSqlite3.Database, table: string): boolean {
	return Boolean(
		sqlite
			.prepare<
				[string],
				{ name: string }
			>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(table),
	);
}

function deleteContentBySlug(
	sqlite: BetterSqlite3.Database,
	collection: string,
	slugs: string[],
): void {
	const table = `ec_${collection}`;
	if (!tableExists(sqlite, table) || slugs.length === 0) return;
	const placeholders = slugs.map(() => "?").join(",");
	sqlite.prepare(`DELETE FROM ${table} WHERE slug IN (${placeholders})`).run(...slugs);
}

function clearPluginStorage(sqlite: BetterSqlite3.Database): void {
	sqlite.prepare("DELETE FROM _plugin_storage WHERE plugin_id = ?").run(PLUGIN_ID);
}

function insertPluginRow(
	sqlite: BetterSqlite3.Database,
	collection: string,
	id: string,
	data: Record<string, unknown>,
): void {
	sqlite
		.prepare(
			`INSERT INTO _plugin_storage (plugin_id, collection, id, data)
			 VALUES (?, ?, ?, ?)`,
		)
		.run(PLUGIN_ID, collection, id, JSON.stringify(data));
}

function upsertOption(sqlite: BetterSqlite3.Database, name: string, value: unknown): void {
	sqlite
		.prepare(
			`INSERT INTO options (name, value)
			 VALUES (?, ?)
			 ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
		)
		.run(name, JSON.stringify(value));
}

function portableParagraph(key: string, text: string): Record<string, unknown> {
	return {
		_type: "block",
		_key: key,
		children: [{ _type: "span", _key: `${key}-span`, text }],
	};
}

async function main(): Promise<void> {
	const startedAt = Date.now();
	if (!existsSync(DB_PATH)) {
		console.log(`Creating demo database at ${DB_PATH}`);
	}

	const sqlite = new BetterSqlite3(DB_PATH);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	const db = new Kysely<Database>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await removeSupersededDemoSchema(registry);
	await ensureCollection(registry, "courses", "Courses", "Course", "graduation-cap", COURSE_FIELDS);
	await ensureCollection(registry, "lessons", "Lessons", "Lesson", "play-circle", LESSON_FIELDS);

	const content = new ContentRepository(db);
	try {
		deleteContentBySlug(sqlite, "lessons", [...LEGACY_LESSON_SLUGS, ...SEEDED_LESSON_SLUGS]);
		deleteContentBySlug(sqlite, "courses", [...LEGACY_COURSE_SLUGS, ...SEEDED_COURSE_SLUGS]);

		clearPluginStorage(sqlite);

		const publishedAt = new Date().toISOString();
		const primaryCourse = await content.create({
			type: "courses",
			slug: "course-publishing-essentials",
			status: "published",
			publishedAt,
			data: {
				title: "Course Publishing Essentials",
				subtitle: "Turn a body of knowledge into a clear public course",
				description:
					"Learn how to shape, publish, and validate structured course content with EmDash Learn.",
				difficulty: "beginner",
				estimated_hours: 1.5,
				body: [
					portableParagraph(
						"course-intro",
						"This short course demonstrates the complete public publishing interface.",
					),
				],
			},
		});

		await content.create({
			type: "courses",
			slug: "course-design-lab",
			status: "published",
			publishedAt,
			data: {
				title: "Course Design Lab",
				subtitle: "A compact second course for catalog browsing",
				description: "Practice outlining lessons before drafting the details.",
				difficulty: "intermediate",
				estimated_hours: 2,
			},
		});

		await content.create({
			type: "courses",
			slug: "unpublished-course-draft",
			status: "draft",
			publishedAt: null,
			data: {
				title: "Unpublished Course Draft",
				description: "This draft must never cross the public route boundary.",
				difficulty: "advanced",
			},
		});

		const firstLesson = await content.create({
			type: "lessons",
			slug: "shape-a-course",
			status: "published",
			publishedAt,
			data: {
				title: "Shape a course",
				course: primaryCourse.id,
				order: 1,
				summary: "Choose a focused promise and arrange the smallest useful lesson sequence.",
				duration_seconds: 480,
				body: [
					portableParagraph(
						"shape-one",
						"Start with the outcome a reader should reach, then work backward to the fewest lessons that support it.",
					),
					portableParagraph(
						"shape-two",
						"Each lesson should make sense on its own while advancing the course promise.",
					),
				],
			},
		});

		const checkLesson = await content.create({
			type: "lessons",
			slug: "publish-with-confidence",
			status: "published",
			publishedAt,
			data: {
				title: "Publish with confidence",
				course: primaryCourse.id,
				order: 2,
				summary: "Validate the public experience and finish with a device-only self-check.",
				duration_seconds: 420,
				body: [
					portableParagraph(
						"publish-one",
						"Preview the catalog, course outline, and every published lesson before sharing the URL.",
					),
					{
						_type: "learnKnowledgeCheck",
						_key: "publishing-check",
						courseId: primaryCourse.id,
						checkId: KNOWLEDGE_CHECK_ID,
					},
				],
			},
		});

		await content.create({
			type: "lessons",
			slug: "draft-lesson-not-public",
			status: "draft",
			publishedAt: null,
			data: {
				title: "Draft lesson not public",
				course: primaryCourse.id,
				order: 3,
				summary: "This draft must not appear in the public outline.",
			},
		});

		const indexRows = [
			{ lesson: firstLesson, order: 1, durationSeconds: 480 },
			{ lesson: checkLesson, order: 2, durationSeconds: 420 },
		];
		for (const row of indexRows) {
			insertPluginRow(
				sqlite,
				"course_content_index",
				`idx__${primaryCourse.id}__lesson__${row.lesson.id}`,
				{
					courseId: primaryCourse.id,
					stepType: "lesson",
					stepId: row.lesson.id,
					order: row.order,
					status: "published",
					publishedAt,
					durationSeconds: row.durationSeconds,
				},
			);
		}

		const now = new Date().toISOString();
		const knowledgeCheckContent = {
			title: "Publishing basics",
			description:
				"A quick anonymous self-check. Its latest result stays in this browser's device progress.",
			passingScore: 70,
			questions: [
				{
					id: "public-boundary",
					type: "single_choice",
					prompt: "Which course content belongs in the public catalog?",
					points: 1,
					options: [
						{ id: "published", text: "Published courses" },
						{ id: "draft", text: "Draft courses" },
						{ id: "trashed", text: "Trashed courses" },
					],
					correctOptionId: "published",
					explanation: "Only published courses cross the public interface.",
				},
				{
					id: "device-result",
					type: "true_false",
					prompt: "This anonymous self-check creates an EmDash account attempt.",
					points: 1,
					correctAnswer: false,
					explanation:
						"Anonymous self-grading creates no account-linked Attempt; the demo remembers the result only on this device.",
				},
			],
		};
		insertPluginRow(sqlite, "assessment_drafts", KNOWLEDGE_CHECK_ID, {
			courseId: primaryCourse.id,
			...knowledgeCheckContent,
			checkId: KNOWLEDGE_CHECK_ID,
			createdAt: now,
			updatedAt: now,
		});
		insertPluginRow(sqlite, "assessment_revisions", KNOWLEDGE_CHECK_REVISION_ID, {
			courseId: primaryCourse.id,
			checkId: KNOWLEDGE_CHECK_ID,
			revisionId: KNOWLEDGE_CHECK_REVISION_ID,
			content: knowledgeCheckContent,
			publishedAt: now,
		});
		insertPluginRow(sqlite, "assessment_heads", KNOWLEDGE_CHECK_ID, {
			checkId: KNOWLEDGE_CHECK_ID,
			revisionId: KNOWLEDGE_CHECK_REVISION_ID,
		});

		upsertOption(sqlite, DIGEST_SECRET_KEY, DEMO_DIGEST_SECRET);
		upsertOption(sqlite, SETUP_STATE_KEY, {
			version: BOOTSTRAP_VERSION,
			completedSteps: [
				"collection:courses",
				"fields:courses",
				"collection:lessons",
				"fields:lessons",
			],
			lastRunAt: now,
			verification: {
				contractVersion: BOOTSTRAP_VERSION,
				schema: "compatible",
				projection: "repaired",
			},
		});
	} finally {
		await db.destroy();
	}

	console.log("Seeded 3 courses, 3 lessons, and 1 published anonymous Knowledge Check.");
	if (process.env.EMDASH_LMS_SEED_VERBOSE === "1") {
		console.log(`Seed completed in ${Date.now() - startedAt} ms`);
	}
}

main().catch((error) => {
	console.error("seed-lms failed:", error);
	process.exitCode = 1;
});

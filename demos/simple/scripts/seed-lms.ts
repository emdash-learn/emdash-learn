/**
 * Emdash Learn demo seed script (§25).
 *
 * Idempotent: re-running wipes plugin storage + fixture rows and recreates
 * them. Drives content through emdash's SchemaRegistry + ContentRepository
 * and writes plugin-owned rows (enrollments, progress, quizzes, …) directly
 * into `_plugin_storage`.
 *
 * Run with: `pnpm --filter ./demos/simple seed`
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";
import { ContentRepository, SchemaRegistry, ulid } from "emdash";
import type { CreateFieldInput, Database } from "emdash";
import { runMigrations } from "emdash/db";
import { Kysely, SqliteDialect } from "kysely";

const PLUGIN_ID = "lms-core";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEMO_ROOT = resolve(SCRIPT_DIR, "..");
const DB_PATH = resolve(DEMO_ROOT, "data.db");

// ---------------------------------------------------------------------------
// Fixture definitions (§25)
// ---------------------------------------------------------------------------

type CourseSeed = {
	localId: string;
	slug: string;
	status: "published" | "draft";
	data: Record<string, unknown>;
};

type LessonSeed = {
	localId: string;
	slug: string;
	status: "published" | "draft";
	courseLocalId: string;
	data: Record<string, unknown>;
};

type UserSeed = {
	localId: string;
	email: string;
	name: string;
	role: 10 | 20 | 30 | 40 | 50;
};

const USERS: UserSeed[] = [
	{ localId: "user_maya", email: "maya@instructor.local", name: "Maya Rivera", role: 40 },
	{ localId: "user_ben", email: "ben@instructor.local", name: "Ben Okafor", role: 40 },
	{ localId: "user_alice", email: "alice@student.local", name: "Alice Chen", role: 10 },
	{ localId: "user_jon", email: "jon@student.local", name: "Jon Park", role: 10 },
	{ localId: "user_lin", email: "lin@student.local", name: "Lin Nguyen", role: 10 },
];

const COURSES: CourseSeed[] = [
	{
		localId: "course_a",
		slug: "getting-started-with-react",
		status: "published",
		data: {
			title: "Getting Started with React",
			subtitle: "Build your first interactive UI",
			description: "A hands-on intro to React fundamentals.",
			difficulty: "beginner",
			estimated_hours: 3,
			price_cents: 0,
			currency: "USD",
			enrollment_open: true,
		},
	},
	{
		localId: "course_b",
		slug: "advanced-sql",
		status: "published",
		data: {
			title: "Advanced SQL",
			subtitle: "Window functions, CTEs, query plans",
			description: "Level up from SELECT * to a confident SQL engineer.",
			difficulty: "advanced",
			estimated_hours: 6,
			price_cents: 4900,
			currency: "USD",
			enrollment_open: true,
		},
	},
	{
		localId: "course_c",
		slug: "shipping-soon-course",
		status: "draft",
		data: {
			title: "Shipping Soon Course",
			subtitle: "Draft content",
			description: "This course isn't published yet.",
			difficulty: "intermediate",
			estimated_hours: 2,
			price_cents: 0,
			currency: "USD",
			enrollment_open: false,
		},
	},
	{
		localId: "course_d",
		slug: "scheduled-drop",
		status: "published",
		data: {
			title: "Scheduled Drop",
			subtitle: "Unlocks soon",
			description: "A course whose first lesson drops one hour from now.",
			difficulty: "beginner",
			estimated_hours: 1,
			price_cents: 0,
			currency: "USD",
			enrollment_open: true,
		},
	},
];

const LESSONS: LessonSeed[] = [
	// Course A — 6 lessons
	{
		localId: "l_a1",
		slug: "react-intro",
		status: "published",
		courseLocalId: "course_a",
		data: {
			title: "Intro to React",
			order: 1,
			summary: "What problems React solves and when to reach for it.",
			video_url: "https://cdn.example.com/videos/react-intro.mp4",
			duration_seconds: 600,
			is_preview: true,
		},
	},
	{
		localId: "l_a2",
		slug: "react-setup",
		status: "published",
		courseLocalId: "course_a",
		data: {
			title: "Project setup",
			order: 2,
			summary: "Scaffold a Vite + React project in two minutes.",
			duration_seconds: 720,
		},
	},
	{
		localId: "l_a3",
		slug: "react-components",
		status: "published",
		courseLocalId: "course_a",
		data: {
			title: "Components",
			order: 3,
			summary: "Function components, JSX, and props.",
			duration_seconds: 900,
		},
	},
	{
		localId: "l_a4",
		slug: "react-state",
		status: "published",
		courseLocalId: "course_a",
		data: {
			title: "State",
			order: 4,
			summary: "useState and local component state.",
			duration_seconds: 900,
		},
	},
	{
		localId: "l_a5",
		slug: "react-effects",
		status: "published",
		courseLocalId: "course_a",
		data: {
			title: "Effects",
			order: 5,
			summary: "useEffect and syncing with external systems.",
			duration_seconds: 960,
		},
	},
	{
		localId: "l_a6",
		slug: "react-deploy",
		status: "published",
		courseLocalId: "course_a",
		data: {
			title: "Deploy",
			order: 6,
			summary: "Ship your app to production.",
			duration_seconds: 720,
			requires_previous: true,
		},
	},
	// Course B — 4 lessons with drip offsets 0/7/14/21
	{
		localId: "l_b1",
		slug: "sql-window",
		status: "published",
		courseLocalId: "course_b",
		data: {
			title: "Window functions",
			order: 1,
			summary: "ROW_NUMBER, RANK, running totals.",
			duration_seconds: 1800,
			drip_offset_days: 0,
		},
	},
	{
		localId: "l_b2",
		slug: "sql-ctes",
		status: "published",
		courseLocalId: "course_b",
		data: {
			title: "CTEs",
			order: 2,
			summary: "Common table expressions and recursive queries.",
			duration_seconds: 1800,
			drip_offset_days: 7,
		},
	},
	{
		localId: "l_b3",
		slug: "sql-plans",
		status: "published",
		courseLocalId: "course_b",
		data: {
			title: "Reading query plans",
			order: 3,
			summary: "EXPLAIN ANALYZE and index usage.",
			duration_seconds: 1800,
			drip_offset_days: 14,
		},
	},
	{
		localId: "l_b4",
		slug: "sql-tuning",
		status: "published",
		courseLocalId: "course_b",
		data: {
			title: "Query tuning",
			order: 4,
			summary: "Practical optimization workflow.",
			duration_seconds: 1800,
			drip_offset_days: 21,
		},
	},
	// Course C — 3 draft lessons (course is locked)
	{
		localId: "l_c1",
		slug: "shipping-soon-1",
		status: "draft",
		courseLocalId: "course_c",
		data: {
			title: "Shipping soon — lesson 1",
			order: 1,
			duration_seconds: 600,
		},
	},
	{
		localId: "l_c2",
		slug: "shipping-soon-2",
		status: "draft",
		courseLocalId: "course_c",
		data: {
			title: "Shipping soon — lesson 2",
			order: 2,
			duration_seconds: 600,
		},
	},
	{
		localId: "l_c3",
		slug: "shipping-soon-3",
		status: "draft",
		courseLocalId: "course_c",
		data: {
			title: "Shipping soon — lesson 3",
			order: 3,
			duration_seconds: 600,
		},
	},
	// Course D — 1 lesson with a future scheduled_at
	{
		localId: "l_d1",
		slug: "scheduled-lesson-one",
		status: "published",
		courseLocalId: "course_d",
		data: {
			title: "Scheduled lesson one",
			order: 1,
			summary: "This lesson unlocks an hour after seed time.",
			duration_seconds: 600,
		},
	},
];

// Deterministic verification code so the E2E suite can hit it directly.
const CERT_VERIFICATION_CODE = "LEARN-DEMO-LIN-A";

// ---------------------------------------------------------------------------
// Schema fixtures — duplicated from src/setup/schema-fixtures so the seed
// script doesn't depend on `src/`. Must stay in sync manually.
// ---------------------------------------------------------------------------

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
	{ slug: "trailer_url", label: "Trailer URL", type: "string", validation: { maxLength: 500 } },
	{
		slug: "difficulty",
		label: "Difficulty",
		type: "select",
		defaultValue: "beginner",
		validation: { options: ["beginner", "intermediate", "advanced"] },
	},
	{ slug: "estimated_hours", label: "Estimated hours", type: "number", validation: { min: 0 } },
	{
		slug: "price_cents",
		label: "Price (cents)",
		type: "integer",
		defaultValue: 0,
		validation: { min: 0 },
	},
	{
		slug: "currency",
		label: "Currency",
		type: "string",
		defaultValue: "USD",
		validation: { pattern: "^[A-Z]{3}$" },
	},
	{ slug: "enrollment_open", label: "Enrollment open", type: "boolean", defaultValue: true },
	{ slug: "enrollment_opens_at", label: "Enrollment opens at", type: "datetime" },
	{ slug: "enrollment_closes_at", label: "Enrollment closes at", type: "datetime" },
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
	{ slug: "is_preview", label: "Preview", type: "boolean", defaultValue: false },
	{
		slug: "requires_previous",
		label: "Requires previous lesson",
		type: "boolean",
		defaultValue: false,
	},
	{ slug: "drip_offset_days", label: "Drip offset (days)", type: "integer", defaultValue: 0 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
	if (!remote) throw new Error(`Collection ${slug} missing after create`);
	const remoteSlugs = new Set(remote.fields.map((f) => f.slug));
	let nextOrder = remote.fields.length;
	for (const field of fields) {
		if (remoteSlugs.has(field.slug)) continue;
		await registry.createField(slug, { ...field, sortOrder: nextOrder });
		nextOrder += 1;
	}
}

function tableName(type: string): string {
	return `ec_${type}`;
}

async function wipeSeededContent(
	sqlite: BetterSqlite3.Database,
	collection: string,
	slugs: string[],
): Promise<void> {
	if (slugs.length === 0) return;
	const placeholders = slugs.map(() => "?").join(",");
	sqlite
		.prepare(`DELETE FROM ${tableName(collection)} WHERE slug IN (${placeholders})`)
		.run(...slugs);
}

function upsertUser(sqlite: BetterSqlite3.Database, user: UserSeed): string {
	const existing = sqlite
		.prepare<[string], { id: string }>("SELECT id FROM users WHERE email = ?")
		.get(user.email);
	if (existing) {
		sqlite
			.prepare("UPDATE users SET name = ?, role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
			.run(user.name, user.role, existing.id);
		return existing.id;
	}
	const id = ulid();
	sqlite
		.prepare(
			`INSERT INTO users (id, email, name, role, email_verified, data)
			 VALUES (?, ?, ?, ?, 1, NULL)`,
		)
		.run(id, user.email, user.name, user.role);
	return id;
}

function deletePluginCollection(sqlite: BetterSqlite3.Database, collection: string): void {
	sqlite
		.prepare(`DELETE FROM _plugin_storage WHERE plugin_id = ? AND collection = ?`)
		.run(PLUGIN_ID, collection);
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const start = Date.now();

	if (!existsSync(DB_PATH)) {
		console.log(`data.db not found at ${DB_PATH}; creating + running migrations.`);
	}

	const dialectSqlite = new BetterSqlite3(DB_PATH);
	dialectSqlite.pragma("journal_mode = WAL");
	dialectSqlite.pragma("foreign_keys = ON");
	const db = new Kysely<Database>({
		dialect: new SqliteDialect({ database: dialectSqlite }),
	});
	await runMigrations(db);

	// Use emdash's APIs to create collections + fields. ContentRepository
	// writes content rows into `ec_*` tables created by SchemaRegistry.
	const registry = new SchemaRegistry(db);
	await ensureCollection(registry, "courses", "Courses", "Course", "graduation-cap", COURSE_FIELDS);
	await ensureCollection(registry, "lessons", "Lessons", "Lesson", "play-circle", LESSON_FIELDS);

	const content = new ContentRepository(db);

	// Reuse the same better-sqlite3 handle the Kysely dialect was built on
	// for raw insert/delete statements (users, plugin_storage).
	const sqlite = dialectSqlite;

	try {
		// Wipe seeded content (leave any dev-created content alone).
		const courseSlugs = COURSES.map((c) => c.slug);
		const lessonSlugs = LESSONS.map((l) => l.slug);
		await wipeSeededContent(sqlite, "courses", courseSlugs);
		await wipeSeededContent(sqlite, "lessons", lessonSlugs);

		// Wipe seeded users (by email) so the re-insert matches summary counts.
		// Keep dev-bypass admin (`dev@emdash.local`) + any other developer users.
		sqlite
			.prepare(`DELETE FROM users WHERE email IN (${USERS.map(() => "?").join(",")})`)
			.run(...USERS.map((u) => u.email));

		// Wipe plugin storage owned by this plugin.
		for (const col of [
			"enrollments",
			"progress",
			"certificates",
			"cohorts",
			"cohort_members",
			"course_instructors",
			"quizzes",
			"quiz_attempts",
		]) {
			deletePluginCollection(sqlite, col);
		}

		// -- Users (+ email <-> id map) -------------------------------------
		const userIds = new Map<string, string>();
		for (const u of USERS) {
			userIds.set(u.localId, upsertUser(sqlite, u));
		}

		// -- Courses + lessons ---------------------------------------------
		const courseIds = new Map<string, string>();
		for (const c of COURSES) {
			const now = new Date().toISOString();
			const item = await content.create({
				type: "courses",
				slug: c.slug,
				status: c.status,
				data: c.data,
				publishedAt: c.status === "published" ? now : null,
			});
			courseIds.set(c.localId, item.id);
		}

		// Attach the quiz to lesson A3's body via the `lmsQuiz` PT block (§5.4).
		// The lesson player surfaces the quiz link when it finds one of these.
		const quizIdForLessonBody = ulid();

		const lessonIds = new Map<string, string>();
		const scheduledAtByLesson = new Map<string, string>();
		for (const l of LESSONS) {
			const courseId = courseIds.get(l.courseLocalId);
			if (!courseId) throw new Error(`Unknown courseLocalId ${l.courseLocalId}`);
			const data: Record<string, unknown> = { ...l.data, course: courseId };
			if (l.localId === "l_a3") {
				data.body = [
					{
						_type: "block",
						_key: "intro",
						children: [{ _type: "span", text: "Short primer before the quiz." }],
					},
					{ _type: "lmsQuiz", _key: "quiz", quizId: quizIdForLessonBody },
				];
			}
			// Course D's lesson is scheduled an hour from seed time.
			let publishedAt: string | null = null;
			if (l.courseLocalId === "course_d") {
				const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
				scheduledAtByLesson.set(l.localId, future);
				// Published with a future `publishedAt` so the content gate reveals
				// once the clock passes it. Drip still applies to enrolled users.
				publishedAt = future;
			} else if (l.status === "published") {
				publishedAt = new Date().toISOString();
			}
			const item = await content.create({
				type: "lessons",
				slug: l.slug,
				status: l.status,
				data,
				publishedAt,
			});
			lessonIds.set(l.localId, item.id);
		}

		// -- Plugin storage ------------------------------------------------
		const now = () => new Date().toISOString();

		// course_instructors: Maya lead on A, B, C; Ben co on A.
		insertPluginRow(sqlite, "course_instructors", ulid(), {
			courseId: courseIds.get("course_a"),
			userId: userIds.get("user_maya"),
			role: "lead",
		});
		insertPluginRow(sqlite, "course_instructors", ulid(), {
			courseId: courseIds.get("course_a"),
			userId: userIds.get("user_ben"),
			role: "co",
		});
		insertPluginRow(sqlite, "course_instructors", ulid(), {
			courseId: courseIds.get("course_b"),
			userId: userIds.get("user_maya"),
			role: "lead",
		});
		insertPluginRow(sqlite, "course_instructors", ulid(), {
			courseId: courseIds.get("course_c"),
			userId: userIds.get("user_maya"),
			role: "lead",
		});

		// cohort: spring-2026, Alice + Jon
		const cohortId = ulid();
		insertPluginRow(sqlite, "cohorts", cohortId, {
			slug: "spring-2026",
			title: "Spring 2026",
			startAt: "2026-03-01T00:00:00.000Z",
			endAt: "2026-06-01T00:00:00.000Z",
			createdAt: now(),
		});
		insertPluginRow(sqlite, "cohort_members", ulid(), {
			cohortId,
			userId: userIds.get("user_alice"),
			role: "student",
			joinedAt: now(),
		});
		insertPluginRow(sqlite, "cohort_members", ulid(), {
			cohortId,
			userId: userIds.get("user_jon"),
			role: "student",
			joinedAt: now(),
		});

		// enrollments (5): alice→A, jon→A, jon→B, lin→A(completed), alice→D
		const enrolls = [
			{ user: "user_alice", course: "course_a", source: "free" as const, completed: false },
			{ user: "user_jon", course: "course_a", source: "free" as const, completed: false },
			{ user: "user_jon", course: "course_b", source: "purchase" as const, completed: false },
			{ user: "user_lin", course: "course_a", source: "free" as const, completed: true },
			{ user: "user_alice", course: "course_d", source: "free" as const, completed: false },
		];
		for (const e of enrolls) {
			const completedAt = e.completed
				? new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
				: undefined;
			const data: Record<string, unknown> = {
				userId: userIds.get(e.user),
				courseId: courseIds.get(e.course),
				enrolledAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
				source: e.source,
			};
			if (completedAt) data.completedAt = completedAt;
			insertPluginRow(sqlite, "enrollments", ulid(), data);
		}

		// progress: Alice → lessons 1-4 of A complete (68% via 4/6 = 66.6…; close enough);
		// Jon → 12% on Course B lesson 1; Lin → all Course A lessons complete.
		const aliceAProgress = ["l_a1", "l_a2", "l_a3", "l_a4"];
		for (const lid of aliceAProgress) {
			insertPluginRow(sqlite, "progress", ulid(), {
				userId: userIds.get("user_alice"),
				courseId: courseIds.get("course_a"),
				lessonId: lessonIds.get(lid),
				startedAt: now(),
				completedAt: now(),
				percentComplete: 100,
			});
		}
		insertPluginRow(sqlite, "progress", ulid(), {
			userId: userIds.get("user_jon"),
			courseId: courseIds.get("course_b"),
			lessonId: lessonIds.get("l_b1"),
			startedAt: now(),
			percentComplete: 12,
			positionSeconds: 220,
		});
		for (const lid of ["l_a1", "l_a2", "l_a3", "l_a4", "l_a5", "l_a6"]) {
			insertPluginRow(sqlite, "progress", ulid(), {
				userId: userIds.get("user_lin"),
				courseId: courseIds.get("course_a"),
				lessonId: lessonIds.get(lid),
				startedAt: now(),
				completedAt: now(),
				percentComplete: 100,
			});
		}

		// quiz (4 MCQs, passing 70%), attached to Lesson 3 of Course A.
		const quizId = quizIdForLessonBody;
		insertPluginRow(sqlite, "quizzes", quizId, {
			title: "React components quiz",
			description: "Check your understanding of JSX and props.",
			passingScore: 70,
			timeLimit: 600,
			timeLimitPolicy: "hard",
			randomize: false,
			questions: [
				{
					id: "q1",
					type: "mcq",
					prompt: "Which hook tracks local component state?",
					points: 1,
					options: [
						{ id: "a", text: "useEffect", correct: false },
						{ id: "b", text: "useState", correct: true },
						{ id: "c", text: "useMemo", correct: false },
						{ id: "d", text: "useRef", correct: false },
					],
				},
				{
					id: "q2",
					type: "mcq",
					prompt: "JSX expressions must be wrapped in…",
					points: 1,
					options: [
						{ id: "a", text: "Parentheses or a single parent element", correct: true },
						{ id: "b", text: "Curly braces only", correct: false },
						{ id: "c", text: "Square brackets", correct: false },
						{ id: "d", text: "Angle brackets without children", correct: false },
					],
				},
				{
					id: "q3",
					type: "mcq",
					prompt: "Props are…",
					points: 1,
					options: [
						{ id: "a", text: "Mutable local state", correct: false },
						{ id: "b", text: "Read-only inputs to a component", correct: true },
						{ id: "c", text: "Global singletons", correct: false },
						{ id: "d", text: "Always strings", correct: false },
					],
				},
				{
					id: "q4",
					type: "mcq",
					prompt: "A component must return…",
					points: 1,
					options: [
						{ id: "a", text: "A number", correct: false },
						{ id: "b", text: "A single React element or null", correct: true },
						{ id: "c", text: "Multiple sibling elements unwrapped", correct: false },
						{ id: "d", text: "A Promise", correct: false },
					],
				},
			],
			createdAt: now(),
			updatedAt: now(),
		});

		// quiz_attempts: Lin passed, Alice failed (45).
		insertPluginRow(sqlite, "quiz_attempts", ulid(), {
			userId: userIds.get("user_lin"),
			quizId,
			lessonId: lessonIds.get("l_a3"),
			startedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
			submittedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000 + 300_000).toISOString(),
			answers: [
				{ questionId: "q1", answer: "b" },
				{ questionId: "q2", answer: "a" },
				{ questionId: "q3", answer: "b" },
				{ questionId: "q4", answer: "b" },
			],
			score: 100,
			passed: true,
			overtime: false,
		});
		insertPluginRow(sqlite, "quiz_attempts", ulid(), {
			userId: userIds.get("user_alice"),
			quizId,
			lessonId: lessonIds.get("l_a3"),
			startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
			submittedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 + 240_000).toISOString(),
			answers: [
				{ questionId: "q1", answer: "a" },
				{ questionId: "q2", answer: "a" },
				{ questionId: "q3", answer: "d" },
				{ questionId: "q4", answer: "c" },
			],
			score: 45,
			passed: false,
			overtime: false,
		});

		// certificate: Lin, Course A.
		insertPluginRow(sqlite, "certificates", ulid(), {
			userId: userIds.get("user_lin"),
			courseId: courseIds.get("course_a"),
			issuedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
			verificationCode: CERT_VERIFICATION_CODE,
		});

		// Log scheduled lesson timestamp for awareness — not part of the summary.
		if (scheduledAtByLesson.size > 0 && process.env.EMDASH_LMS_SEED_VERBOSE === "1") {
			console.log(`Course D lesson scheduled at ${scheduledAtByLesson.get("l_d1")}`);
		}
	} finally {
		await db.destroy();
	}

	const elapsed = Date.now() - start;
	console.log(
		"Seeded 4 courses, 14 lessons, 5 users, 5 enrollments, 1 quiz, 2 attempts, 1 certificate.",
	);
	if (process.env.EMDASH_LMS_SEED_VERBOSE === "1") {
		console.log(`(seed completed in ${elapsed} ms)`);
	}
}

main().catch((err) => {
	console.error("seed-lms failed:", err);
	process.exitCode = 1;
});

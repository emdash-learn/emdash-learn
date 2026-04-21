/**
 * Fixture helpers for integration tests (§18.3).
 *
 * Two families of helpers:
 *   - Content-backed (`seedCourse`, `seedLesson`) — go through emdash's
 *     `ctx.content.create()`. The plugin uses the content API at runtime, so
 *     seeds exercise the same write path.
 *   - Plugin-storage-backed (`seedEnrollment`, `seedProgress`, `seedQuiz`) —
 *     go straight through `ctx.storage.<collection>.put()`. This matches how
 *     engine modules write in production.
 *
 * `seedStudent` inserts into emdash's core `users` table directly because
 * the v1 plugin context exposes no write path for users. It uses the db
 * handle retrieved through `getTestDb(ctx)`, so callers still pass the ctx
 * they already have — no second parameter.
 *
 * Types are intentionally loose here (Record<string, unknown> / `any` in a
 * few spots): the fixtures ran ahead of T03's storage-type work, and the
 * values they build are the same shapes declared in `src/types/storage.ts`
 * anyway. Future refactors can tighten these without changing call sites.
 */

import { ulid } from "emdash";
import type { ContentItem, PluginContext } from "emdash";

import { getTestDb } from "./test-plugin-ctx.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireContentWrite(ctx: PluginContext): {
	create: (collection: string, data: Record<string, unknown>) => Promise<ContentItem>;
} {
	const content = ctx.content;
	if (!content || typeof content.create !== "function") {
		throw new Error(
			"seed: ctx.content.create is unavailable — did you pass a ctx from createTestPluginCtx?",
		);
	}
	return content as {
		create: (collection: string, data: Record<string, unknown>) => Promise<ContentItem>;
	};
}

// Storage accessor is declared against a `Record<string, unknown>` T here so
// seed helpers can call `put` with arbitrary shapes without each helper
// needing to know the full types. T03 owns the narrowed types.
function collection(
	ctx: PluginContext,
	name: string,
): {
	put(id: string, data: Record<string, unknown>): Promise<void>;
} {
	// eslint-disable-next-line typescript-eslint/no-explicit-any -- see module header
	const store = (ctx.storage as any)[name];
	if (!store || typeof store.put !== "function") {
		throw new Error(
			`seed: ctx.storage.${name} is unavailable — the plugin descriptor may not declare this collection.`,
		);
	}
	return store as { put(id: string, data: Record<string, unknown>): Promise<void> };
}

// ---------------------------------------------------------------------------
// Course + Lesson (content collections)
// ---------------------------------------------------------------------------

export interface SeedCourseInput {
	title?: string;
	subtitle?: string;
	description?: string;
	priceCents?: number;
	currency?: string;
	enrollmentOpen?: boolean;
	enrollmentOpensAt?: string;
	enrollmentClosesAt?: string;
	difficulty?: "beginner" | "intermediate" | "advanced";
	estimatedHours?: number;
}

/**
 * Insert a row into the `courses` content collection. Only `title` and the
 * engine-relevant fields are exposed — tests that need niche fields should
 * call `ctx.content.create("courses", { ... })` directly.
 */
export async function seedCourse(
	ctx: PluginContext,
	input: SeedCourseInput = {},
): Promise<ContentItem> {
	const content = requireContentWrite(ctx);
	const data: Record<string, unknown> = {
		title: input.title ?? "Seed Course",
	};
	if (input.subtitle !== undefined) data.subtitle = input.subtitle;
	if (input.description !== undefined) data.description = input.description;
	if (input.priceCents !== undefined) data.price_cents = input.priceCents;
	if (input.currency !== undefined) data.currency = input.currency;
	if (input.enrollmentOpen !== undefined) data.enrollment_open = input.enrollmentOpen;
	if (input.enrollmentOpensAt !== undefined) data.enrollment_opens_at = input.enrollmentOpensAt;
	if (input.enrollmentClosesAt !== undefined) data.enrollment_closes_at = input.enrollmentClosesAt;
	if (input.difficulty !== undefined) data.difficulty = input.difficulty;
	if (input.estimatedHours !== undefined) data.estimated_hours = input.estimatedHours;
	return content.create("courses", data);
}

export interface SeedLessonInput {
	courseId: string;
	title?: string;
	order?: number;
	summary?: string;
	videoUrl?: string;
	durationSeconds?: number;
	isPreview?: boolean;
	requiresPrevious?: boolean;
	dripOffsetDays?: number;
	/** Quiz ID to attach to this lesson (populates the `quiz` field). */
	quizId?: string;
}

/**
 * Insert a row into the `lessons` content collection. `courseId` is required
 * — matches the reference field declared in the T01 schema fixtures.
 */
export async function seedLesson(ctx: PluginContext, input: SeedLessonInput): Promise<ContentItem> {
	const content = requireContentWrite(ctx);
	const data: Record<string, unknown> = {
		title: input.title ?? "Seed Lesson",
		course: input.courseId,
		order: input.order ?? 0,
	};
	if (input.summary !== undefined) data.summary = input.summary;
	if (input.videoUrl !== undefined) data.video_url = input.videoUrl;
	if (input.durationSeconds !== undefined) data.duration_seconds = input.durationSeconds;
	if (input.isPreview !== undefined) data.is_preview = input.isPreview;
	if (input.requiresPrevious !== undefined) data.requires_previous = input.requiresPrevious;
	if (input.dripOffsetDays !== undefined) data.drip_offset_days = input.dripOffsetDays;
	if (input.quizId !== undefined) data.quiz = input.quizId;
	return content.create("lessons", data);
}

// ---------------------------------------------------------------------------
// Student (core users table)
// ---------------------------------------------------------------------------

export interface SeedStudentInput {
	email: string;
	name?: string;
	role?: number;
}

export interface SeedStudentResult {
	id: string;
	email: string;
	name: string | null;
	role: number;
	createdAt: string;
}

/**
 * Insert a row into emdash's core `users` table. Defaults to the SUBSCRIBER
 * role (10) — pass `role` from `@emdash-cms/auth`'s `Role` enum to seed an
 * instructor or admin.
 */
export async function seedStudent(
	ctx: PluginContext,
	input: SeedStudentInput,
): Promise<SeedStudentResult> {
	const db = getTestDb(ctx);
	const id = `user_${ulid()}`;
	const now = new Date().toISOString();
	const role = input.role ?? 10; // @emdash-cms/auth Role.SUBSCRIBER
	const name = input.name ?? input.email.split("@")[0] ?? null;

	await db
		.insertInto("users")
		.values({
			id,
			email: input.email,
			name,
			avatar_url: null,
			role,
			email_verified: 1,
			data: null,
			created_at: now,
			updated_at: now,
		})
		.execute();

	return { id, email: input.email, name, role, createdAt: now };
}

// ---------------------------------------------------------------------------
// Plugin-storage-backed fixtures
// ---------------------------------------------------------------------------

export interface SeedEnrollmentInput {
	userId: string;
	courseId: string;
	source?: "free" | "purchase" | "invite" | "admin";
	enrolledAt?: string;
	cohortId?: string;
	completedAt?: string;
}

export interface SeedEnrollmentResult {
	id: string;
	userId: string;
	courseId: string;
	enrolledAt: string;
	source: "free" | "purchase" | "invite" | "admin";
}

/**
 * Insert a row into the plugin's `enrollments` storage collection.
 */
export async function seedEnrollment(
	ctx: PluginContext,
	input: SeedEnrollmentInput,
): Promise<SeedEnrollmentResult> {
	const id = `enr_${ulid()}`;
	const enrolledAt = input.enrolledAt ?? new Date().toISOString();
	const source = input.source ?? "free";
	const data: Record<string, unknown> = {
		userId: input.userId,
		courseId: input.courseId,
		enrolledAt,
		source,
	};
	if (input.cohortId !== undefined) data.cohortId = input.cohortId;
	if (input.completedAt !== undefined) data.completedAt = input.completedAt;
	await collection(ctx, "enrollments").put(id, data);
	return { id, userId: input.userId, courseId: input.courseId, enrolledAt, source };
}

export interface SeedTopicInput {
	courseId: string;
	lessonId: string;
	title?: string;
	order?: number;
	summary?: string;
	videoUrl?: string;
	durationSeconds?: number;
	requiresPrevious?: boolean;
}

/**
 * Insert a row into the `topics` content collection. `lessonId` and
 * `courseId` are both required because the topic schema mirrors the
 * `course` reference for query locality (ADR 0001).
 */
export async function seedTopic(ctx: PluginContext, input: SeedTopicInput): Promise<ContentItem> {
	const content = requireContentWrite(ctx);
	const data: Record<string, unknown> = {
		title: input.title ?? "Seed Topic",
		lesson: input.lessonId,
		course: input.courseId,
		order: input.order ?? 0,
	};
	if (input.summary !== undefined) data.summary = input.summary;
	if (input.videoUrl !== undefined) data.video_url = input.videoUrl;
	if (input.durationSeconds !== undefined) data.duration_seconds = input.durationSeconds;
	if (input.requiresPrevious !== undefined) data.requires_previous = input.requiresPrevious;
	return content.create("topics", data);
}

export interface SeedProgressInput {
	userId: string;
	courseId: string;
	stepType?: "lesson" | "topic";
	stepId: string;
	parentLessonId?: string;
	percentComplete?: number;
	startedAt?: string;
	completedAt?: string;
	positionSeconds?: number;
}

export interface SeedProgressResult {
	id: string;
	userId: string;
	courseId: string;
	stepType: "lesson" | "topic";
	stepId: string;
	percentComplete: number;
}

/**
 * Insert a row into the plugin's `step_progress` storage collection (ADR 0001).
 */
export async function seedProgress(
	ctx: PluginContext,
	input: SeedProgressInput,
): Promise<SeedProgressResult> {
	const id = `prog_${ulid()}`;
	const percentComplete = input.percentComplete ?? 0;
	const startedAt = input.startedAt ?? new Date().toISOString();
	const stepType = input.stepType ?? "lesson";
	const data: Record<string, unknown> = {
		userId: input.userId,
		courseId: input.courseId,
		stepType,
		stepId: input.stepId,
		percentComplete,
		startedAt,
	};
	if (input.parentLessonId !== undefined) data.parentLessonId = input.parentLessonId;
	if (input.completedAt !== undefined) data.completedAt = input.completedAt;
	if (input.positionSeconds !== undefined) data.positionSeconds = input.positionSeconds;
	await collection(ctx, "step_progress").put(id, data);
	return {
		id,
		userId: input.userId,
		courseId: input.courseId,
		stepType,
		stepId: input.stepId,
		percentComplete,
	};
}

export interface SeedQuizQuestionInput {
	id?: string;
	type?: "mcq" | "multi" | "true_false" | "short_text";
	prompt?: string;
	options?: Array<{ id: string; text: string; correct: boolean }>;
	explanation?: string;
	points?: number;
}

export interface SeedQuizInput {
	title?: string;
	description?: string;
	passingScore?: number;
	timeLimit?: number;
	timeLimitPolicy?: "hard" | "soft";
	randomize?: boolean;
	questions: SeedQuizQuestionInput[];
}

export interface SeedQuizResult {
	id: string;
	title: string;
	passingScore: number;
}

/**
 * Insert a row into the plugin's `quizzes` storage collection. Question
 * defaults keep declarations lean in tests: omit a field, get a reasonable
 * default that matches §5.3 types/storage.ts.
 */
export async function seedQuiz(ctx: PluginContext, input: SeedQuizInput): Promise<SeedQuizResult> {
	const id = `quiz_${ulid()}`;
	const now = new Date().toISOString();
	const title = input.title ?? "Seed Quiz";
	const passingScore = input.passingScore ?? 70;
	const questions = input.questions.map((q, i) => ({
		id: q.id ?? `q${i + 1}`,
		type: q.type ?? "mcq",
		prompt: q.prompt ?? `Question ${i + 1}`,
		options: q.options ?? [],
		explanation: q.explanation,
		points: q.points ?? 1,
	}));
	const data: Record<string, unknown> = {
		title,
		description: input.description,
		passingScore,
		timeLimit: input.timeLimit,
		timeLimitPolicy: input.timeLimitPolicy ?? "hard",
		randomize: input.randomize ?? false,
		questions,
		createdAt: now,
		updatedAt: now,
	};
	await collection(ctx, "quizzes").put(id, data);
	return { id, title, passingScore };
}

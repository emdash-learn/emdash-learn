/**
 * Progress engine — step-aware (ADR 0001).
 *
 * Replaces the original lesson-only progress engine. Every progress row is
 * keyed by `(userId, stepType, stepId)` where `stepType ∈ {"lesson", "topic"}`.
 * Topics inherit their gating from the parent lesson (via `parentLessonId`),
 * and a lesson cannot be marked complete until all its child topics are
 * complete.
 *
 * Public API:
 *   - `tick`               — heartbeat from the player. Auto-completes the
 *     step when `percentComplete >= 90`. For topic ticks, when the topic
 *     auto-completes the engine checks whether the parent lesson now
 *     qualifies for completion (lesson body 100% AND all sibling topics
 *     complete) and cascades.
 *   - `markStepComplete`   — explicit "I'm done" entrypoint. Emits
 *     `lesson:completed` for lesson rows and `topic:completed` for topic
 *     rows. Marking a lesson complete while topics remain incomplete
 *     returns `LEARN_LESSON_LOCKED` ("topics incomplete").
 *   - `getForUser`         — paginated read of `step_progress` rows for one
 *     `(userId, courseId)`.
 *   - `evaluateCourseComplete` — true iff every published lesson AND every
 *     published topic has a completed row.
 *
 * Course-completion definition (§12 Q26 + ADR 0001): every published
 * step (lesson body + topics, including preview lesson bodies) has a
 * completed `step_progress` row.
 */

import type { PluginContext, StorageCollection } from "emdash";

import { LEARN_ERRORS, LESSONS_COLLECTION_SLUG, TOPICS_COLLECTION_SLUG } from "../constants.js";
import type { CourseCompleted, LessonCompleted, TopicCompleted } from "../types/engine.js";
import type { CourseContentIndexRow, Enrollment, StepProgress, StepType } from "../types/storage.js";
import { emit } from "./event-bus.js";
import { err, ok, type Result } from "./result.js";

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function getCollection<T>(ctx: PluginContext, name: string): StorageCollection<T> {
	const collection = (ctx.storage as Record<string, StorageCollection | undefined>)[name];
	if (!collection) {
		throw new Error(`Plugin storage collection "${name}" is not declared in the descriptor.`);
	}
	return collection as StorageCollection<T>;
}

const STEP_PROGRESS_COLLECTION = "step_progress";

/**
 * Deterministic id for a `(userId, stepType, stepId)` progress row. Encoding
 * `stepType` into the id prevents lesson/topic rows for the same id from
 * colliding (very unlikely with content ULIDs, but the id space is shared).
 */
function progressId(userId: string, stepType: StepType, stepId: string): string {
	return `prog__${userId}__${stepType}__${stepId}`;
}

// ---------------------------------------------------------------------------
// Lesson + topic content lookup
// ---------------------------------------------------------------------------

interface LessonContext {
	courseId: string;
	status: string;
}

async function readLessonContext(
	ctx: PluginContext,
	lessonId: string,
): Promise<LessonContext | null> {
	if (!ctx.content) return null;
	const item = await ctx.content.get(LESSONS_COLLECTION_SLUG, lessonId);
	if (!item) return null;
	const courseRef = item.data["course"];
	if (typeof courseRef !== "string" || !courseRef) return null;
	return { courseId: courseRef, status: item.status };
}

interface TopicContext {
	courseId: string;
	parentLessonId: string;
	status: string;
}

async function readTopicContext(ctx: PluginContext, topicId: string): Promise<TopicContext | null> {
	if (!ctx.content) return null;
	const item = await ctx.content.get(TOPICS_COLLECTION_SLUG, topicId);
	if (!item) return null;
	const lessonRef = item.data["lesson"];
	const courseRef = item.data["course"];
	if (typeof lessonRef !== "string" || !lessonRef) return null;
	if (typeof courseRef !== "string" || !courseRef) return null;
	return { courseId: courseRef, parentLessonId: lessonRef, status: item.status };
}

interface PublishedItem {
	id: string;
}

const CONTENT_INDEX_COLLECTION = "course_content_index";

async function listPublishedLessonsForCourse(
	ctx: PluginContext,
	courseId: string,
): Promise<PublishedItem[]> {
	const store = getCollection<CourseContentIndexRow>(ctx, CONTENT_INDEX_COLLECTION);
	const matches: PublishedItem[] = [];
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		// The projection only contains published rows — status filter is implicit.
		const page = await store.query({
			where: { courseId, stepType: "lesson" },
			limit: 100,
			cursor,
		});
		for (const row of page.items) {
			matches.push({ id: row.data.stepId });
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
	return matches;
}

async function listPublishedTopicsForCourse(
	ctx: PluginContext,
	courseId: string,
): Promise<PublishedItem[]> {
	const store = getCollection<CourseContentIndexRow>(ctx, CONTENT_INDEX_COLLECTION);
	const matches: PublishedItem[] = [];
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		// The projection only contains published rows — status filter is implicit.
		const page = await store.query({
			where: { courseId, stepType: "topic" },
			limit: 100,
			cursor,
		});
		for (const row of page.items) {
			matches.push({ id: row.data.stepId });
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
	return matches;
}

async function listPublishedTopicsForLesson(
	ctx: PluginContext,
	lessonId: string,
): Promise<PublishedItem[]> {
	const store = getCollection<CourseContentIndexRow>(ctx, CONTENT_INDEX_COLLECTION);
	const matches: PublishedItem[] = [];
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		// The projection only contains published rows — status filter is implicit.
		// Query by lessonId and stepType (both indexed: lessonId is indexed,
		// stepType is part of the ["courseId","stepType"] compound index).
		const page = await store.query({
			where: { lessonId, stepType: "topic" },
			limit: 100,
			cursor,
		});
		for (const row of page.items) {
			matches.push({ id: row.data.stepId });
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
	return matches;
}

// ---------------------------------------------------------------------------
// Progress queries
// ---------------------------------------------------------------------------

interface ProgressLookup {
	id: string;
	row: StepProgress;
}

async function getProgressByStep(
	ctx: PluginContext,
	userId: string,
	stepType: StepType,
	stepId: string,
): Promise<ProgressLookup | null> {
	const collection = getCollection<StepProgress>(ctx, STEP_PROGRESS_COLLECTION);
	const id = progressId(userId, stepType, stepId);
	const row = await collection.get(id);
	if (!row) return null;
	if (row.userId !== userId || row.stepType !== stepType || row.stepId !== stepId) return null;
	return { id, row };
}

async function getEnrollment(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<{ id: string; row: Enrollment } | null> {
	const collection = getCollection<Enrollment>(ctx, "enrollments");
	const result = await collection.query({ where: { userId, courseId }, limit: 1 });
	const item = result.items[0];
	if (!item) return null;
	return { id: item.id, row: item.data };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TickInput {
	stepType: StepType;
	stepId: string;
	positionSeconds: number;
	percentComplete: number;
}

/**
 * Auto-complete threshold for `tick`. Pinned at 90% per §8.2 / §21 Phase 2.
 */
export const PROGRESS_AUTO_COMPLETE_THRESHOLD = 90;

interface ResolvedStep {
	courseId: string;
	parentLessonId?: string;
}

async function resolveStep(
	ctx: PluginContext,
	stepType: StepType,
	stepId: string,
): Promise<ResolvedStep | null> {
	if (stepType === "lesson") {
		const lessonCtx = await readLessonContext(ctx, stepId);
		if (!lessonCtx) return null;
		return { courseId: lessonCtx.courseId };
	}
	const topicCtx = await readTopicContext(ctx, stepId);
	if (!topicCtx) return null;
	return { courseId: topicCtx.courseId, parentLessonId: topicCtx.parentLessonId };
}

/**
 * Heartbeat from the lesson player. Upserts the `step_progress` row and
 * triggers `markStepComplete` when percent crosses the auto-complete
 * threshold. Monotonic on `percentComplete` — never lets the value regress.
 */
export async function tick(
	ctx: PluginContext,
	userId: string,
	input: TickInput,
): Promise<Result<StepProgress>> {
	const resolved = await resolveStep(ctx, input.stepType, input.stepId);
	if (!resolved) {
		const code =
			input.stepType === "topic" ? LEARN_ERRORS.TOPIC_LOCKED : LEARN_ERRORS.LESSON_LOCKED;
		return err(code, `Step ${input.stepId} is not available.`);
	}

	const enrollment = await getEnrollment(ctx, userId, resolved.courseId);
	if (!enrollment || enrollment.row.revokedAt) {
		return err(
			LEARN_ERRORS.NOT_ENROLLED,
			`User ${userId} is not enrolled in course ${resolved.courseId}.`,
		);
	}

	const collection = getCollection<StepProgress>(ctx, STEP_PROGRESS_COLLECTION);
	const existing = await getProgressByStep(ctx, userId, input.stepType, input.stepId);
	const now = new Date().toISOString();

	// Already-complete rows are immutable on percent — once completedAt is set
	// the bar never walks back.
	if (existing?.row.completedAt) {
		const refreshed: StepProgress = {
			...existing.row,
			positionSeconds: input.positionSeconds,
		};
		await collection.put(existing.id, refreshed);
		return ok(refreshed);
	}

	const monotonicPercent = Math.max(input.percentComplete, existing?.row.percentComplete ?? 0);
	const next: StepProgress = {
		userId,
		courseId: resolved.courseId,
		stepType: input.stepType,
		stepId: input.stepId,
		startedAt: existing?.row.startedAt ?? now,
		percentComplete: monotonicPercent,
		positionSeconds: input.positionSeconds,
	};
	if (resolved.parentLessonId !== undefined) {
		next.parentLessonId = resolved.parentLessonId;
	}

	const id = existing?.id ?? progressId(userId, input.stepType, input.stepId);
	await collection.put(id, next);

	if (monotonicPercent >= PROGRESS_AUTO_COMPLETE_THRESHOLD) {
		const completed = await markStepComplete(ctx, userId, input.stepType, input.stepId);
		if (!completed.ok) return completed as Result<StepProgress>;
		const refreshed = await getProgressByStep(ctx, userId, input.stepType, input.stepId);
		return ok(refreshed?.row ?? next);
	}

	return ok(next);
}

/**
 * Finalize a lesson or topic as complete and propagate completion upward.
 *
 * For topics: writes the topic row, emits `topic:completed`, then if all
 * sibling topics are complete AND the parent lesson body itself is complete
 * (or the lesson has no body progress required because completion cascades
 * via topics), cascades to lesson completion.
 *
 * For lessons: refuses with `LEARN_LESSON_LOCKED` if any child topic is
 * incomplete. Otherwise writes the lesson row, emits `lesson:completed`,
 * then evaluates course completion.
 */
export async function markStepComplete(
	ctx: PluginContext,
	userId: string,
	stepType: StepType,
	stepId: string,
): Promise<Result<{ courseComplete: boolean }>> {
	if (stepType === "topic") {
		return markTopicCompleteInternal(ctx, userId, stepId);
	}
	return markLessonCompleteInternal(ctx, userId, stepId);
}

async function markTopicCompleteInternal(
	ctx: PluginContext,
	userId: string,
	topicId: string,
): Promise<Result<{ courseComplete: boolean }>> {
	const topicCtx = await readTopicContext(ctx, topicId);
	if (!topicCtx) {
		return err(LEARN_ERRORS.TOPIC_LOCKED, `Topic ${topicId} is not available.`);
	}

	const enrollment = await getEnrollment(ctx, userId, topicCtx.courseId);
	if (!enrollment || enrollment.row.revokedAt) {
		return err(
			LEARN_ERRORS.NOT_ENROLLED,
			`User ${userId} is not enrolled in course ${topicCtx.courseId}.`,
		);
	}

	const collection = getCollection<StepProgress>(ctx, STEP_PROGRESS_COLLECTION);
	const existing = await getProgressByStep(ctx, userId, "topic", topicId);
	const now = new Date().toISOString();

	const completedRow: StepProgress = {
		userId,
		courseId: topicCtx.courseId,
		stepType: "topic",
		stepId: topicId,
		parentLessonId: topicCtx.parentLessonId,
		startedAt: existing?.row.startedAt ?? now,
		percentComplete: 100,
		completedAt: existing?.row.completedAt ?? now,
	};
	if (existing?.row.positionSeconds !== undefined) {
		completedRow.positionSeconds = existing.row.positionSeconds;
	}
	const id = existing?.id ?? progressId(userId, "topic", topicId);
	await collection.put(id, completedRow);

	const event: TopicCompleted = {
		name: "topic:completed",
		key: `tc:${userId}:${topicId}`,
		data: completedRow,
		critical: true,
	};
	await emit(event, ctx);

	// Try to cascade lesson completion. Only succeeds when every other
	// published topic on the lesson is complete AND the lesson's own body
	// progress row is complete (per the lesson-completion rule). When the
	// lesson hasn't been touched at all we don't auto-complete it — the
	// lesson body still requires its own 90% threshold.
	const lessonStatus = await isLessonReadyForCompletion(ctx, userId, topicCtx.parentLessonId);
	if (lessonStatus.ready) {
		const cascade = await markLessonCompleteInternal(ctx, userId, topicCtx.parentLessonId);
		if (!cascade.ok) return cascade;
		return ok({ courseComplete: cascade.data.courseComplete });
	}

	return ok({ courseComplete: false });
}

interface LessonReadyResult {
	ready: boolean;
}

/**
 * `true` iff every published child topic of `lessonId` is complete AND the
 * lesson body's own progress row is complete. Used by the topic-cascade path:
 * we don't want to mark the lesson complete just because the topics are done
 * if the user hasn't actually watched the lesson body.
 */
async function isLessonReadyForCompletion(
	ctx: PluginContext,
	userId: string,
	lessonId: string,
): Promise<LessonReadyResult> {
	const topics = await listPublishedTopicsForLesson(ctx, lessonId);
	const collection = getCollection<StepProgress>(ctx, STEP_PROGRESS_COLLECTION);

	for (const topic of topics) {
		// eslint-disable-next-line no-await-in-loop
		const row = await collection.get(progressId(userId, "topic", topic.id));
		if (!row?.completedAt) return { ready: false };
	}

	const lessonRow = await collection.get(progressId(userId, "lesson", lessonId));
	if (!lessonRow?.completedAt) return { ready: false };
	return { ready: true };
}

async function markLessonCompleteInternal(
	ctx: PluginContext,
	userId: string,
	lessonId: string,
): Promise<Result<{ courseComplete: boolean }>> {
	const lessonCtx = await readLessonContext(ctx, lessonId);
	if (!lessonCtx) {
		return err(LEARN_ERRORS.LESSON_LOCKED, `Lesson ${lessonId} is not available.`);
	}

	const enrollment = await getEnrollment(ctx, userId, lessonCtx.courseId);
	if (!enrollment || enrollment.row.revokedAt) {
		return err(
			LEARN_ERRORS.NOT_ENROLLED,
			`User ${userId} is not enrolled in course ${lessonCtx.courseId}.`,
		);
	}

	// Lesson cannot be marked complete while any published child topic is
	// incomplete. The topic-cascade path uses `markStepComplete` for the
	// lesson, but only after `isLessonReadyForCompletion` has cleared the
	// gate, so the cascade satisfies this check by construction.
	const topics = await listPublishedTopicsForLesson(ctx, lessonId);
	const stepProgress = getCollection<StepProgress>(ctx, STEP_PROGRESS_COLLECTION);
	for (const topic of topics) {
		// eslint-disable-next-line no-await-in-loop
		const row = await stepProgress.get(progressId(userId, "topic", topic.id));
		if (!row?.completedAt) {
			return err(LEARN_ERRORS.LESSON_LOCKED, "topics incomplete");
		}
	}

	const existing = await getProgressByStep(ctx, userId, "lesson", lessonId);
	const now = new Date().toISOString();
	const completedRow: StepProgress = {
		userId,
		courseId: lessonCtx.courseId,
		stepType: "lesson",
		stepId: lessonId,
		startedAt: existing?.row.startedAt ?? now,
		percentComplete: 100,
		completedAt: existing?.row.completedAt ?? now,
	};
	if (existing?.row.positionSeconds !== undefined) {
		completedRow.positionSeconds = existing.row.positionSeconds;
	}
	const id = existing?.id ?? progressId(userId, "lesson", lessonId);
	await stepProgress.put(id, completedRow);

	const lessonEvent: LessonCompleted = {
		name: "lesson:completed",
		key: `lc:${userId}:${lessonId}`,
		data: completedRow,
		critical: true,
	};
	await emit(lessonEvent, ctx);

	const courseDone = await evaluateCourseComplete(ctx, userId, lessonCtx.courseId);
	if (!courseDone.ok) return courseDone as Result<{ courseComplete: boolean }>;
	if (!courseDone.data) return ok({ courseComplete: false });

	const enrollments = getCollection<Enrollment>(ctx, "enrollments");
	const completedEnrollment: Enrollment = {
		...enrollment.row,
		completedAt: enrollment.row.completedAt ?? now,
	};
	await enrollments.put(enrollment.id, completedEnrollment);

	const courseEvent: CourseCompleted = {
		name: "course:completed",
		key: `cc:${userId}:${lessonCtx.courseId}`,
		data: completedEnrollment,
		critical: true,
	};
	await emit(courseEvent, ctx);

	return ok({ courseComplete: true });
}

/**
 * Paginated read of a single user's progress for a single course. Returns
 * both lesson and topic rows.
 */
export async function getForUser(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<Result<StepProgress[]>> {
	const collection = getCollection<StepProgress>(ctx, STEP_PROGRESS_COLLECTION);
	const out: StepProgress[] = [];
	let cursor: string | undefined;
	/* oxlint-disable no-await-in-loop */
	do {
		const page = await collection.query({
			where: { userId, courseId },
			limit: 100,
			cursor,
		});
		for (const item of page.items) out.push(item.data);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	/* oxlint-enable no-await-in-loop */
	return ok(out);
}

/**
 * `true` iff every published lesson AND every published topic in the course
 * has a completed row for the given user. Returns `false` (not error) for
 * empty courses.
 */
export async function evaluateCourseComplete(
	ctx: PluginContext,
	userId: string,
	courseId: string,
): Promise<Result<boolean>> {
	const lessons = await listPublishedLessonsForCourse(ctx, courseId);
	const topics = await listPublishedTopicsForCourse(ctx, courseId);
	if (lessons.length === 0 && topics.length === 0) return ok(false);

	const progress = await getForUser(ctx, userId, courseId);
	if (!progress.ok) return progress as Result<boolean>;

	const completedLesson = new Set(
		progress.data
			.filter((row) => row.stepType === "lesson" && row.completedAt)
			.map((row) => row.stepId),
	);
	const completedTopic = new Set(
		progress.data
			.filter((row) => row.stepType === "topic" && row.completedAt)
			.map((row) => row.stepId),
	);
	const allLessons = lessons.every((l) => completedLesson.has(l.id));
	const allTopics = topics.every((t) => completedTopic.has(t.id));
	return ok(allLessons && allTopics);
}

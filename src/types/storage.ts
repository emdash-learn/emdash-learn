/**
 * Plugin-storage value shapes (§5.3 of prd-plugin.md). These are the `data`
 * shapes stored in `ctx.storage.*`. Index and unique-index declarations live in
 * `src/index.ts` on the descriptor, not here.
 */

export type EnrollmentSource = "free" | "purchase" | "invite" | "admin";

export interface Enrollment {
	userId: string;
	courseId: string;
	enrolledAt: string;
	source: EnrollmentSource;
	orderId?: string;
	cohortId?: string;
	completedAt?: string;
	revokedAt?: string;
	revokedReason?: string;
	/** Timestamp when the welcome email was sent; set by send-lifecycle-emails reconciler (Track C). */
	welcomeSentAt?: string;
	/** Timestamp when the course-completion email was sent; set by send-lifecycle-emails reconciler (Track C). */
	completionSentAt?: string;
}

/**
 * Per-step progress (ADR 0001). Replaces the previous lesson-only `Progress`
 * shape. One row per `(userId, stepType, stepId)`. `parentLessonId` is set
 * only on `stepType === "topic"` rows so "all progress within this lesson"
 * queries stay cheap.
 */
export type StepType = "lesson" | "topic";

export interface StepProgress {
	userId: string;
	courseId: string;
	stepType: StepType;
	stepId: string;
	parentLessonId?: string;
	startedAt: string;
	completedAt?: string;
	percentComplete: number;
	positionSeconds?: number;
}

export type QuestionType = "mcq" | "multi" | "true_false" | "short_text";

export interface QuizQuestionOption {
	id: string;
	text: string;
	correct: boolean;
}

export interface QuizQuestion {
	id: string;
	type: QuestionType;
	prompt: string;
	options?: QuizQuestionOption[];
	explanation?: string;
	points: number;
}

export type QuizTimeLimitPolicy = "hard" | "soft";

export interface Quiz {
	title: string;
	description?: string;
	passingScore: number;
	timeLimit?: number;
	timeLimitPolicy: QuizTimeLimitPolicy;
	randomize: boolean;
	questions: QuizQuestion[];
	createdAt: string;
	updatedAt: string;
}

export interface QuizAttemptAnswer {
	questionId: string;
	answer: unknown;
}

export interface QuizAttempt {
	userId: string;
	quizId: string;
	lessonId?: string;
	startedAt: string;
	submittedAt?: string;
	answers: QuizAttemptAnswer[];
	score?: number;
	passed?: boolean;
	overtime?: boolean;
}

export interface Certificate {
	userId: string;
	courseId: string;
	issuedAt: string;
	expiresAt?: string;
	verificationCode: string;
	revokedAt?: string;
}

export interface Cohort {
	slug: string;
	title: string;
	startAt?: string;
	endAt?: string;
	capacity?: number;
	createdAt: string;
}

export type CohortMemberRole = "student" | "ta";

export interface CohortMember {
	cohortId: string;
	userId: string;
	joinedAt: string;
	role: CohortMemberRole;
}

export type InstructorRole = "lead" | "co" | "ta";

export interface CourseInstructor {
	courseId: string;
	userId: string;
	role: InstructorRole;
	bioOverride?: string;
}

/**
 * Denormalized projection of lessons and topics for indexed curriculum reads
 * (AUDIT C3). One row per `(courseId, stepType, stepId)`. Maintained by
 * `content:afterSave` / `content:afterDelete` hooks; backfilled on first run
 * by the `backfill-content-index` reconciler.
 */
export interface CourseContentIndexRow {
	courseId: string;
	stepType: "lesson" | "topic";
	/** lessonId for lessons, topicId for topics */
	stepId: string;
	/** parent lesson id for topics */
	lessonId?: string;
	order: number;
	status: "published" | "draft" | "scheduled";
	publishedAt?: string;
	scheduledAt?: string;
	durationSeconds?: number;
	/** lessons only */
	isPreview?: boolean;
	requiresPrevious?: boolean;
	/** lessons only */
	dripOffsetDays?: number;
}

/**
 * Wizard progress record persisted under `state:bootstrap`.
 */
export interface BootstrapState {
	version: number;
	completedSteps: string[];
	lastRunAt?: string;
	lastError?: { stepId: string; message: string; at: string };
}

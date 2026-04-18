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
}

export interface Progress {
	userId: string;
	courseId: string;
	lessonId: string;
	startedAt: string;
	completedAt?: string;
	positionSeconds?: number;
	percentComplete: number;
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
 * Wizard progress record persisted under `state:bootstrap`.
 */
export interface BootstrapState {
	version: number;
	completedSteps: string[];
	lastRunAt?: string;
	lastError?: { stepId: string; message: string; at: string };
}

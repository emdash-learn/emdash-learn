/**
 * Engine-event catalog (§8.1).
 *
 * The event bus has been removed (AUDIT C1, Track C — Decision: Rip).
 * This file is retained as a reference for the event shapes that were
 * previously emitted; they are kept here for documentation purposes only
 * and are not used at runtime. If an event-bus model is reintroduced in
 * a future version, these types provide the shape contract.
 *
 * Production fan-out (welcome email, completion email) is now handled by
 * the `send-lifecycle-emails` reconciler in `src/reconcilers/`.
 */

import type { Certificate, Enrollment, QuizAttempt, StepProgress } from "./storage.js";

interface BaseEvent<TName extends string, TKey extends string, TData> {
	name: TName;
	key: TKey;
	data: TData;
	critical?: boolean;
}

export type EnrollmentCreated = BaseEvent<"enrollment:created", `enroll:${string}`, Enrollment>;
export type EnrollmentRevoked = BaseEvent<
	"enrollment:revoked",
	`revoke:${string}`,
	{ enrollmentId: string; reason?: string }
>;
export type LessonCompleted = BaseEvent<"lesson:completed", `lc:${string}:${string}`, StepProgress>;
export type TopicCompleted = BaseEvent<"topic:completed", `tc:${string}:${string}`, StepProgress>;
export type CourseCompleted = BaseEvent<"course:completed", `cc:${string}:${string}`, Enrollment>;
export type QuizAttempted = BaseEvent<"quiz:attempted", `qa:${string}`, QuizAttempt>;
export type CertificateIssued = BaseEvent<"certificate:issued", `cert:${string}`, Certificate>;
export type LessonReleased = BaseEvent<
	"lesson:released",
	`rel:${string}`,
	{ lessonId: string; scheduledAt: string }
>;
export type CoursePublished = BaseEvent<"course:published", `cp:${string}`, { courseId: string }>;

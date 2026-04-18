/**
 * Engine-event catalog (§8.1). Every event carries an idempotency `key` so the
 * event bus (T02) can dedupe re-drives via KV markers.
 *
 * `critical` is a routing hint the dispatcher consults (§8.2):
 *   - `true`  — handler throw propagates to the route and fails the request.
 *   - `false` — handler throw is swallowed; reconciler sweeps will retry.
 */

import type { Certificate, Enrollment, Progress, QuizAttempt } from "./storage.js";

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
export type LessonCompleted = BaseEvent<"lesson:completed", `lc:${string}:${string}`, Progress>;
export type CourseCompleted = BaseEvent<"course:completed", `cc:${string}:${string}`, Enrollment>;
export type QuizAttempted = BaseEvent<"quiz:attempted", `qa:${string}`, QuizAttempt>;
export type CertificateIssued = BaseEvent<"certificate:issued", `cert:${string}`, Certificate>;
export type LessonReleased = BaseEvent<
	"lesson:released",
	`rel:${string}`,
	{ lessonId: string; scheduledAt: string }
>;
export type CoursePublished = BaseEvent<"course:published", `cp:${string}`, { courseId: string }>;

export type EngineEvent =
	| EnrollmentCreated
	| EnrollmentRevoked
	| LessonCompleted
	| CourseCompleted
	| QuizAttempted
	| CertificateIssued
	| LessonReleased
	| CoursePublished;

export type EngineEventName = EngineEvent["name"];

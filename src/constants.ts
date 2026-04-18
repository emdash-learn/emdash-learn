/**
 * Plugin-wide constants: identity, bootstrap version, default settings, error
 * codes. Everything that's either literal-valued or enum-like lives here so the
 * engine never ships ad-hoc strings.
 */

export const PLUGIN_ID = "lms-core";
export const PLUGIN_VERSION = "0.0.0";

/**
 * Incremented whenever the setup wizard's frozen schema set or seeded default
 * KV values change. Re-running the wizard against an older bootstrap marker
 * replays the idempotent steps and brings the install up to current.
 */
export const BOOTSTRAP_VERSION = 1;

/**
 * Default KV values seeded on plugin:install. Admin settings UI (T24) later
 * lets admins override them.
 */
export const DEFAULT_SETTINGS = {
	defaultPassingScore: 70,
	certificateExpiryDays: null as number | null,
	dripMode: "immediate" as "immediate" | "relative",
	commentGateRequiresEnrollment: false,
} as const;

export const COURSES_COLLECTION_SLUG = "courses";
export const LESSONS_COLLECTION_SLUG = "lessons";

/**
 * Error codes surfaced by the engine (§17.6). Kept in an `as const` object so
 * other modules can both narrow on the union and reference individual codes
 * without string duplication.
 */
export const LEARN_ERRORS = {
	NOT_ENROLLED: "LEARN_NOT_ENROLLED",
	ALREADY_ENROLLED: "LEARN_ALREADY_ENROLLED",
	ENROLLMENT_CLOSED: "LEARN_ENROLLMENT_CLOSED",
	COHORT_AT_CAPACITY: "LEARN_COHORT_AT_CAPACITY",
	LESSON_LOCKED: "LEARN_LESSON_LOCKED",
	QUIZ_NOT_STARTED: "LEARN_QUIZ_NOT_STARTED",
	QUIZ_TIMEOUT: "LEARN_QUIZ_TIMEOUT",
	CERT_NOT_FOUND: "LEARN_CERT_NOT_FOUND",
	COURSE_HAS_ENROLLMENTS: "LEARN_COURSE_HAS_ENROLLMENTS",
	SETUP_INCOMPLETE: "LEARN_SETUP_INCOMPLETE",
	NOT_INSTRUCTOR: "LEARN_NOT_INSTRUCTOR",
	SETUP_FAILED: "LEARN_SETUP_FAILED",
	SCHEMA_CONFLICT: "LEARN_SCHEMA_CONFLICT",
} as const;

export type LearnErrorCode = (typeof LEARN_ERRORS)[keyof typeof LEARN_ERRORS];

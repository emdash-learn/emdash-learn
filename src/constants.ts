/** Stable plugin identity shared by the descriptor, runtime, and clients. */
export const PLUGIN_ID = "lms-core";

// Replaced by tsdown so the runtime descriptor matches package.json.
// oxlint-disable-next-line no-underscore-dangle
declare const __PLUGIN_VERSION__: string;
export const PLUGIN_VERSION: string =
	typeof __PLUGIN_VERSION__ !== "undefined" ? __PLUGIN_VERSION__ : "0.0.0";

/**
 * Schema generation understood by the setup gate.
 *
 * Version 4 is the first publishing-only contract: Course → Lesson, with no
 * topics or personalized-learning fields.
 */
export const BOOTSTRAP_VERSION = 4;

export const COURSES_COLLECTION_SLUG = "courses";
export const LESSONS_COLLECTION_SLUG = "lessons";

export const LEARN_ERRORS = {
	SETUP_INCOMPLETE: "LEARN_SETUP_INCOMPLETE",
} as const;

export type LearnErrorCode = (typeof LEARN_ERRORS)[keyof typeof LEARN_ERRORS];

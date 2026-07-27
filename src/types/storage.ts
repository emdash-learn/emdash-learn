/**
 * Denormalized pointer to one published lesson.
 *
 * EmDash's plugin content API cannot filter by arbitrary reference fields, so
 * this shallow projection makes `course:get` local and bounded. The actual
 * content item remains authoritative and is rechecked before public output.
 */
export interface CourseContentIndexRow {
	courseId: string;
	stepType: "lesson";
	stepId: string;
	order: number;
	status: "published";
}

/** Setup progress persisted in the plugin KV namespace. */
export interface BootstrapState {
	version: number;
	completedSteps: string[];
	lastRunAt?: string;
	lastError?: { stepId: string; message: string; at: string };
	verification?: {
		contractVersion: number;
		schema: "compatible";
		projection: "repaired";
	};
}

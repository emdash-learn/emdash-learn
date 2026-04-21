/**
 * Admin api-client: typed RPC wrapper over every plugin route the LMS exposes.
 * Admin UI code imports this module only — never `engine/*` (§17.2 rule #2).
 */

import { PLUGIN_ID } from "../constants.js";
import type {
	CohortImportInput,
	CohortAddMemberInput,
	CohortCreateInput,
	CohortGetInput,
	CohortListInput,
	CohortRemoveMemberInput,
} from "../routes/instructor-cohorts.js";
import type {
	InstructorListInput,
	InstructorListItem,
	InstructorListResponse,
	InstructorSetInput,
	InstructorUnsetInput,
} from "../routes/instructor-assignments.js";
import type { CatalogInput, CatalogPage } from "../routes/public-catalog.js";
import type { CertificateVerifyInput } from "../routes/public-certificates.js";
import type { VerificationResult } from "../routes/public-certificates.js";
import type {
	QuizCreateInput,
	QuizDeleteInput,
	QuizListInput,
	QuizStartInput,
	QuizSubmitInput,
	QuizUpdateInput,
	StartAttemptResult,
	SubmitAttemptResult,
} from "../routes/quizzes.js";
import type { CertificatesMineInput } from "../routes/student-certificates.js";
import type {
	CurriculumInput,
	LessonInput,
	MyLearningInput,
	MyLearningPage,
	TopicInput,
	VisibleLesson,
	VisibleTopic,
} from "../routes/student-curriculum.js";
import type { LessonListInput, LessonSummary } from "../routes/instructor-lessons.js";
import type {
	TopicCreateInput,
	TopicDeleteInput,
	TopicGetInput,
	TopicListInput,
	TopicReorderInput,
	TopicUpdateInput,
} from "../routes/instructor-topics.js";
import type { EnrollInput, UnenrollInput } from "../routes/student-enrollments.js";
import type { ProgressCompleteInput, ProgressTickInput } from "../routes/student-progress.js";
import type {
	ActivityItem,
	CourseOverview,
	CourseSummary,
	DashboardStats,
	QuizStats,
	StudentProgress,
} from "../routes/instructor-analytics.js";
import type {
	CourseComparison,
	DateRange,
	EngagementMetrics,
	PaginatedResult,
	SiteAnalytics,
} from "../routes/admin-analytics.js";
import type {
	SettingsGetResponse,
	SettingsUpdateInput,
	SettingsUpdateResponse,
	TestEmailInput,
	TestEmailResponse,
} from "../routes/admin-settings.js";
import type {
	BootstrapState,
	Certificate,
	Cohort,
	CohortMember,
	CourseInstructor,
	Enrollment,
	Quiz,
	StepProgress,
} from "../types/storage.js";
import type { SettingsShape } from "../constants.js";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class LmsApiError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "LmsApiError";
	}
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface SetupStateResponse {
	state: BootstrapState;
	targetVersion: number;
}

export interface SetupMarkInput {
	completedSteps: string[];
	lastError?: { stepId: string; message: string; at: string };
}

export interface SetupMarkResponse {
	state: BootstrapState;
}

export interface EnrollResponse {
	ok: true;
	enrollmentId?: string;
	enrollment: Enrollment;
}

export interface UnenrollResponse {
	ok: true;
	enrollment: Enrollment;
}

export interface ProgressTickResponse {
	ok: true;
	progress: StepProgress;
}

export interface ProgressCompleteResponse {
	ok: true;
	courseComplete: boolean;
}

export interface CurriculumResponse {
	items: VisibleLesson[];
}

/** Minimal shape for a content item returned by the `lesson` route. */
export interface LessonContentItem {
	id: string;
	slug?: string | null;
	status?: string;
	publishedAt?: string | null;
	data: Record<string, unknown>;
}

export interface LessonResponse {
	lesson: LessonContentItem;
}

/** Topic body returned by the student `topic` route. */
export interface TopicContentItem {
	id: string;
	slug?: string | null;
	status?: string;
	publishedAt?: string | null;
	data: Record<string, unknown>;
}

export interface TopicResponse {
	topic: TopicContentItem;
}

export interface TopicSummary {
	id: string;
	slug?: string | null;
	status?: string;
	publishedAt?: string | null;
	lessonId?: string;
	courseId?: string;
	order?: number;
	title?: string;
}

export interface TopicListResponse {
	items: TopicSummary[];
	cursor?: string;
	hasMore: boolean;
}

export interface LessonListResponse {
	items: LessonSummary[];
	cursor?: string;
	hasMore: boolean;
}

export interface TopicGetResponse {
	topic: TopicContentItem;
}

export interface TopicMutationResponse {
	topic: TopicContentItem;
}

export interface TopicDeleteResponse {
	ok: true;
}

export interface TopicReorderResponse {
	reordered: TopicSummary[];
}

export interface QuizRecordResponse {
	id: string;
	quiz: Quiz;
}

export interface QuizListResponse {
	items: Array<{ id: string } & Quiz>;
	cursor?: string;
	hasMore: boolean;
}

export interface QuizDeleteResponse {
	ok: true;
}

export interface CertificatesMineResponse {
	items: Array<{ id: string } & Certificate>;
	cursor?: string;
	hasMore: boolean;
}

export interface CohortRecordResponse {
	id: string;
	cohort: Cohort;
}

export interface CohortListResponse {
	items: Array<{ id: string; memberCount: number } & Cohort>;
	cursor?: string;
	hasMore: boolean;
}

export interface CohortDetailResponse {
	id: string;
	cohort: Cohort;
	members: Array<{ id: string } & CohortMember>;
}

export interface CohortMemberResponse {
	id: string;
	member: CohortMember;
}

export interface CohortRemoveMemberResponse {
	ok: true;
}

export interface CohortImportResponse {
	added: Array<{ id: string } & CohortMember>;
	unknownEmails: string[];
	alreadyMembers: string[];
	capacityRejected: string[];
	counts: { added: number; unknown: number; alreadyMembers: number; capacityRejected: number };
}

export interface InstructorSetResponse {
	ok: true;
	assignment: CourseInstructor;
}

export interface InstructorUnsetResponse {
	ok: true;
}

export interface RecentActivityInput {
	limit?: number;
}

export interface CourseIdInput {
	courseId: string;
}

export interface TimelineInput {
	courseId: string;
	days?: number;
}

export interface ProgressMatrixInput {
	courseId: string;
	cursor?: string;
	limit?: number;
}

export interface StudentProgressByUserInput {
	studentId: string;
}

export interface TimelinePoint {
	date: string;
	count: number;
}

export interface CompletionFunnel {
	started: number;
	q25: number;
	q50: number;
	q75: number;
	completed: number;
}

export interface ProgressMatrix {
	students: Array<{
		userId: string;
		name: string;
		lessonProgress: Record<string, number>;
	}>;
	nextCursor?: string;
}

export interface CsvExportResponse {
	csv: string;
}

export interface DateRangeInput {
	range: DateRange;
	cursor?: string;
	limit?: number;
}

// Re-export engine-derived types so admin consumers can type variables.
export type {
	ActivityItem,
	BootstrapState,
	CatalogPage,
	Certificate,
	Cohort,
	CohortMember,
	CourseComparison,
	CourseInstructor,
	CourseOverview,
	CourseSummary,
	DashboardStats,
	DateRange,
	EngagementMetrics,
	Enrollment,
	InstructorListItem,
	InstructorListResponse,
	LessonSummary,
	MyLearningPage,
	PaginatedResult,
	Quiz,
	StepProgress,
	QuizStats,
	SettingsGetResponse,
	SettingsShape,
	SettingsUpdateInput,
	SettingsUpdateResponse,
	SiteAnalytics,
	StartAttemptResult,
	StudentProgress,
	SubmitAttemptResult,
	TestEmailInput,
	TestEmailResponse,
	VerificationResult,
	VisibleLesson,
	VisibleTopic,
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface CreateApiClientOptions {
	fetch?: typeof fetch;
	baseUrl?: string;
}

interface ApiSuccessEnvelope<T> {
	data: T;
}

interface ApiErrorEnvelope {
	error: { code: string; message: string };
}

function isApiError(body: unknown): body is ApiErrorEnvelope {
	return (
		typeof body === "object" &&
		body !== null &&
		"error" in body &&
		typeof (body as { error: unknown }).error === "object" &&
		(body as { error: unknown }).error !== null
	);
}

function isApiSuccess<T>(body: unknown): body is ApiSuccessEnvelope<T> {
	return typeof body === "object" && body !== null && "data" in (body as object);
}

export function createApiClient(opts: CreateApiClientOptions = {}) {
	const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
	const baseUrl = opts.baseUrl ?? `/_emdash/api/plugins/${PLUGIN_ID}`;

	async function request<TOut>(routeName: string, input?: unknown): Promise<TOut> {
		// Non-GET private plugin routes require `X-EmDash-Request: 1` per
		// emdash's CSRF guard. Session cookie is ambient on same-origin.
		// Always send `{}` (not omit) so Zod schemas don't reject `undefined`.
		const url = `${baseUrl}/${routeName}`;
		const body = JSON.stringify(input ?? {});
		let res: Response;
		try {
			res = await fetchImpl(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"X-EmDash-Request": "1",
				},
				credentials: "same-origin",
				body,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new LmsApiError("NETWORK_ERROR", message, 0);
		}

		const text = await res.text();
		let parsed: unknown;
		if (text.length === 0) {
			parsed = null;
		} else {
			try {
				parsed = JSON.parse(text);
			} catch {
				throw new LmsApiError("NETWORK_ERROR", "Server returned non-JSON response", res.status);
			}
		}

		if (!res.ok) {
			if (isApiError(parsed)) {
				throw new LmsApiError(parsed.error.code, parsed.error.message, res.status);
			}
			throw new LmsApiError("MALFORMED_RESPONSE", `Request failed (${res.status})`, res.status);
		}

		if (!isApiSuccess<TOut>(parsed)) {
			throw new LmsApiError(
				"MALFORMED_RESPONSE",
				"Response envelope missing `data` field",
				res.status,
			);
		}
		return parsed.data;
	}

	return {
		setup: {
			state: () => request<SetupStateResponse>("setup:state"),
			mark: (input: SetupMarkInput) => request<SetupMarkResponse>("setup:mark", input),
		},

		enrollments: {
			enroll: (input: EnrollInput) => request<EnrollResponse>("enroll", input),
			unenroll: (input: UnenrollInput) => request<UnenrollResponse>("unenroll", input),
		},

		progress: {
			tick: (input: ProgressTickInput) => request<ProgressTickResponse>("progress:tick", input),
			complete: (input: ProgressCompleteInput) =>
				request<ProgressCompleteResponse>("progress:complete", input),
		},

		curriculum: {
			get: (input: CurriculumInput) => request<CurriculumResponse>("curriculum", input),
			lesson: (input: LessonInput) => request<LessonResponse>("lesson", input),
			topic: (input: TopicInput) => request<TopicResponse>("topic", input),
			myLearning: (input?: MyLearningInput) => request<MyLearningPage>("my-learning", input ?? {}),
		},

		lessons: {
			list: (input: LessonListInput) => request<LessonListResponse>("lesson:list", input),
		},

		topics: {
			list: (input?: TopicListInput) => request<TopicListResponse>("topic:list", input ?? {}),
			get: (input: TopicGetInput) => request<TopicGetResponse>("topic:get", input),
			create: (input: TopicCreateInput) => request<TopicMutationResponse>("topic:create", input),
			update: (input: TopicUpdateInput) => request<TopicMutationResponse>("topic:update", input),
			delete: (input: TopicDeleteInput) => request<TopicDeleteResponse>("topic:delete", input),
			reorder: (input: TopicReorderInput) => request<TopicReorderResponse>("topic:reorder", input),
		},

		quizzes: {
			start: (input: QuizStartInput) => request<StartAttemptResult>("quiz:start", input),
			submit: (input: QuizSubmitInput) => request<SubmitAttemptResult>("quiz:submit", input),
			create: (input: QuizCreateInput) => request<QuizRecordResponse>("quiz:create", input),
			update: (input: QuizUpdateInput) => request<QuizRecordResponse>("quiz:update", input),
			list: (input?: QuizListInput) => request<QuizListResponse>("quiz:list", input ?? {}),
			delete: (input: QuizDeleteInput) => request<QuizDeleteResponse>("quiz:delete", input),
		},

		certificates: {
			mine: (input?: CertificatesMineInput) =>
				request<CertificatesMineResponse>("certificates:mine", input ?? {}),
			verify: (input: CertificateVerifyInput) =>
				request<VerificationResult>("certificate:verify", input),
		},

		cohorts: {
			create: (input: CohortCreateInput) => request<CohortRecordResponse>("cohort:create", input),
			list: (input?: CohortListInput) => request<CohortListResponse>("cohort:list", input ?? {}),
			get: (input: CohortGetInput) => request<CohortDetailResponse>("cohort:get", input),
			addMember: (input: CohortAddMemberInput) =>
				request<CohortMemberResponse>("cohort:add-member", input),
			removeMember: (input: CohortRemoveMemberInput) =>
				request<CohortRemoveMemberResponse>("cohort:remove-member", input),
			import: (input: CohortImportInput) => request<CohortImportResponse>("cohort:import", input),
		},

		instructors: {
			set: (input: InstructorSetInput) => request<InstructorSetResponse>("instructor:set", input),
			unset: (input: InstructorUnsetInput) =>
				request<InstructorUnsetResponse>("instructor:unset", input),
			list: (input?: InstructorListInput) =>
				request<InstructorListResponse>("instructor:list", input ?? {}),
		},

		instructorAnalytics: {
			dashboardStats: () => request<DashboardStats>("instructor:dashboard-stats"),
			dashboardCourses: () => request<CourseSummary[]>("instructor:dashboard-courses"),
			recentActivity: (input?: RecentActivityInput) =>
				request<ActivityItem[]>("instructor:recent-activity", input ?? {}),
			courseOverview: (input: CourseIdInput) =>
				request<CourseOverview>("instructor:course-overview", input),
			courseEnrollmentsTimeline: (input: TimelineInput) =>
				request<TimelinePoint[]>("instructor:course-enrollments-timeline", input),
			courseCompletionFunnel: (input: CourseIdInput) =>
				request<CompletionFunnel>("instructor:course-completion-funnel", input),
			courseProgressMatrix: (input: ProgressMatrixInput) =>
				request<ProgressMatrix>("instructor:course-progress-matrix", input),
			courseQuizStats: (input: CourseIdInput) =>
				request<QuizStats[]>("instructor:course-quiz-stats", input),
			studentProgress: (input: StudentProgressByUserInput) =>
				request<StudentProgress>("instructor:student-progress", input),
			enrollmentsExport: (input: CourseIdInput) =>
				request<CsvExportResponse>("instructor:enrollments-export", input),
			progressExport: (input: CourseIdInput) =>
				request<CsvExportResponse>("instructor:progress-export", input),
		},

		adminAnalytics: {
			overview: (input: DateRangeInput) =>
				request<SiteAnalytics>("admin:analytics-overview", input),
			coursesComparison: (input: DateRangeInput) =>
				request<PaginatedResult<CourseComparison>>("admin:courses-comparison", input),
			engagementMetrics: (input: DateRangeInput) =>
				request<EngagementMetrics>("admin:engagement-metrics", input),
		},

		settings: {
			get: () => request<SettingsGetResponse>("admin:settings:get"),
			update: (input: SettingsUpdateInput) =>
				request<SettingsUpdateResponse>("admin:settings:update", input),
			testEmail: (input?: TestEmailInput) =>
				request<TestEmailResponse>("admin:test-email", input ?? {}),
		},

		catalog: (input?: CatalogInput) => request<CatalogPage>("catalog", input ?? {}),
	};
}

export type ApiClient = ReturnType<typeof createApiClient>;

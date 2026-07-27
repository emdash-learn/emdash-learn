import type { CourseProgress, LessonCompletionResult } from "../modules/learning-record/index.js";
import type { PrivacyErasureResult } from "../modules/privacy-erasure.js";
import {
	createDeviceProgressStore,
	type BrowserStorage,
	type DeviceCourseProgress,
	type DeviceProgressStore,
} from "./device-progress.js";

const DEFAULT_BASE_URL = "/_emdash/api/plugins/lms-core";

export class LearnBrowserApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
		readonly details?: Record<string, unknown>,
	) {
		super(message);
		this.name = "LearnBrowserApiError";
	}
}

export interface LearnBrowserClientOptions {
	storage: BrowserStorage;
	fetch?: typeof fetch;
	baseUrl?: string;
	nextOperationId?: () => string;
}

export interface DeviceImportResult {
	importedLessons: number;
	importedLessonIds: string[];
	ignoredLessons: number;
	progress: CourseProgress;
}

export type BrowserLessonCompletion =
	| ({ mode: "account" } & LessonCompletionResult)
	| { mode: "device"; progress: DeviceCourseProgress };

export interface LearnBrowserClient {
	readonly deviceProgress: DeviceProgressStore;
	/**
	 * Records one directional Course view. Reporting is best-effort, so this
	 * method always resolves and must not be used as an acknowledgement.
	 */
	observeCourseOpened(courseId: string): Promise<void>;
	/**
	 * Records one directional Lesson view. Reporting is best-effort, so this
	 * method always resolves and must not be used as an acknowledgement.
	 */
	observeLessonOpened(input: { courseId: string; lessonId: string }): Promise<void>;
	completeLesson(input: { courseId: string; lessonId: string }): Promise<BrowserLessonCompletion>;
	getCourseProgress(courseId: string): Promise<CourseProgress>;
	importDeviceProgress(courseId: string): Promise<DeviceImportResult | null>;
	eraseMyData(): Promise<PrivacyErasureResult>;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? Object.fromEntries(Object.entries(value))
		: null;
}

export function createLearnBrowserClient(options: LearnBrowserClientOptions): LearnBrowserClient {
	const fetcher =
		options.fetch ??
		((input: URL | RequestInfo, init?: RequestInit) => globalThis.fetch(input, init));
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
	const nextOperationId = options.nextOperationId ?? (() => globalThis.crypto.randomUUID());
	const deviceProgress = createDeviceProgressStore(options.storage);

	async function request<T>(route: string, input: unknown): Promise<T> {
		let response: Response;
		try {
			response = await fetcher(`${baseUrl}/${route}`, {
				method: "POST",
				credentials: "same-origin",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					"X-EmDash-Request": "1",
				},
				body: JSON.stringify(input),
			});
		} catch (error) {
			throw new LearnBrowserApiError(
				"NETWORK_ERROR",
				error instanceof Error ? error.message : "Learn request failed.",
				0,
			);
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new LearnBrowserApiError(
				"MALFORMED_RESPONSE",
				"Learn returned a non-JSON response.",
				response.status,
			);
		}
		const envelope = record(body);
		if (!response.ok) {
			const error = record(envelope?.["error"]);
			throw new LearnBrowserApiError(
				typeof error?.["code"] === "string" ? error["code"] : "LEARN_REQUEST_FAILED",
				typeof error?.["message"] === "string"
					? error["message"]
					: `Learn request failed (${response.status}).`,
				response.status,
				record(error?.["details"]) ?? undefined,
			);
		}
		if (!envelope || !("data" in envelope)) {
			throw new LearnBrowserApiError(
				"MALFORMED_RESPONSE",
				"Learn response is missing its data field.",
				response.status,
			);
		}
		// The server route owns runtime validation; this generic assertion is
		// confined to the typed transport boundary.
		// oxlint-disable-next-line typescript-eslint(no-unsafe-type-assertion)
		return envelope["data"] as T;
	}

	async function observeOpen(
		input:
			| { type: "course_opened"; courseId: string }
			| { type: "lesson_opened"; courseId: string; lessonId: string },
	): Promise<void> {
		try {
			await request<{ accepted: true }>("engagement:observe", input);
		} catch {
			// Directional reporting must never block or fail page navigation.
		}
	}

	return {
		deviceProgress,
		observeCourseOpened(courseId) {
			return observeOpen({ type: "course_opened", courseId });
		},
		observeLessonOpened(input) {
			return observeOpen({ type: "lesson_opened", ...input });
		},
		async completeLesson(input) {
			try {
				const result = await request<LessonCompletionResult>("learning:complete-lesson", {
					lessonId: input.lessonId,
					operationId: nextOperationId(),
				});
				return { mode: "account", ...result };
			} catch (error) {
				if (
					!(error instanceof LearnBrowserApiError) ||
					(error.status !== 401 && error.status !== 403)
				) {
					throw error;
				}
			}
			return {
				mode: "device",
				progress: deviceProgress.completeLesson(input.courseId, input.lessonId),
			};
		},
		getCourseProgress(courseId) {
			return request<CourseProgress>("learning:progress", { courseId });
		},
		async importDeviceProgress(courseId) {
			const progress = deviceProgress.getCourse(courseId);
			if (!progress || progress.completedLessonIds.length === 0) return null;
			return request<DeviceImportResult>("learning:import-device-progress", {
				courseId,
				lessonIds: progress.completedLessonIds,
				operationId: nextOperationId(),
			});
		},
		eraseMyData() {
			return request<PrivacyErasureResult>("privacy:erase-my-data", {});
		},
	};
}

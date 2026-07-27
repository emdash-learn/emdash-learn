import {
	createDeviceProgressStore,
	type BrowserStorage,
	type DeviceCourseProgress,
	type DeviceProgressStore,
} from "./device-progress.js";

const DEFAULT_BASE_URL = "/_emdash/api/plugins/lms-core";

export interface LearnBrowserClientOptions {
	storage: BrowserStorage;
	fetch?: typeof fetch;
	baseUrl?: string;
}

export interface BrowserLessonCompletion {
	mode: "device";
	progress: DeviceCourseProgress;
}

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
	/** Records a Lesson completion only in the supplied browser storage. */
	completeLesson(input: { courseId: string; lessonId: string }): Promise<BrowserLessonCompletion>;
}

export function createLearnBrowserClient(options: LearnBrowserClientOptions): LearnBrowserClient {
	const fetcher =
		options.fetch ??
		((input: URL | RequestInfo, init?: RequestInit) => globalThis.fetch(input, init));
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
	const deviceProgress = createDeviceProgressStore(options.storage);

	async function observeOpen(
		input:
			| { type: "course_opened"; courseId: string }
			| { type: "lesson_opened"; courseId: string; lessonId: string },
	): Promise<void> {
		try {
			const response = await fetcher(`${baseUrl}/engagement:observe`, {
				method: "POST",
				credentials: "same-origin",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					"X-EmDash-Request": "1",
				},
				body: JSON.stringify(input),
			});
			if (!response.ok) {
				throw new Error(`Learn observation failed (${response.status}).`);
			}
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
			return {
				mode: "device",
				progress: deviceProgress.completeLesson(input.courseId, input.lessonId),
			};
		},
	};
}

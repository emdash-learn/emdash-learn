import { describe, expect, it, vi } from "vitest";

import {
	createLearnBrowserClient,
	LearnBrowserApiError,
} from "../../../src/browser/learning-client.js";
import type { BrowserStorage } from "../../../src/browser/device-progress.js";

function storage(): BrowserStorage {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
		removeItem: (key) => values.delete(key),
	};
}

function response(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("Learn browser client", () => {
	it("emits typed Course and Lesson open observations through the public route", async () => {
		const fetcher = vi.fn<typeof fetch>();
		fetcher
			.mockResolvedValueOnce(response({ data: { accepted: true } }))
			.mockResolvedValueOnce(response({ data: { accepted: true } }));
		const client = createLearnBrowserClient({
			storage: storage(),
			fetch: fetcher,
		});

		await client.observeCourseOpened("course-1");
		await client.observeLessonOpened({ courseId: "course-1", lessonId: "lesson-1" });

		expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
			"/_emdash/api/plugins/lms-core/engagement:observe",
			"/_emdash/api/plugins/lms-core/engagement:observe",
		]);
		expect(fetcher.mock.calls.map((call) => call[1]?.body)).toEqual([
			'{"type":"course_opened","courseId":"course-1"}',
			'{"type":"lesson_opened","courseId":"course-1","lessonId":"lesson-1"}',
		]);
	});

	it("keeps Course and Lesson navigation fail-open when reporting is unavailable", async () => {
		const fetcher = vi.fn<typeof fetch>();
		fetcher
			.mockRejectedValueOnce(new TypeError("network unavailable"))
			.mockResolvedValueOnce(
				response({ error: { code: "LEARN_RATE_LIMITED", message: "Try again." } }, 429),
			);
		const client = createLearnBrowserClient({
			storage: storage(),
			fetch: fetcher,
		});

		await expect(client.observeCourseOpened("course-1")).resolves.toBeUndefined();
		await expect(
			client.observeLessonOpened({ courseId: "course-1", lessonId: "lesson-1" }),
		).resolves.toBeUndefined();
	});

	it("uses verified account progress when the private completion route succeeds", async () => {
		const fetcher = vi.fn<typeof fetch>();
		fetcher.mockResolvedValue(
			response({
				data: {
					newlyCompleted: true,
					completedAt: "2026-07-26T12:00:00.000Z",
					progress: {
						courseId: "course-1",
						totalLessons: 2,
						completedLessons: 1,
						percentComplete: 50,
					},
				},
			}),
		);
		const browserStorage = storage();
		const client = createLearnBrowserClient({
			storage: browserStorage,
			fetch: fetcher,
			nextOperationId: () => "00000000-0000-4000-8000-000000000001",
		});

		await expect(
			client.completeLesson({ courseId: "course-1", lessonId: "lesson-1" }),
		).resolves.toMatchObject({
			mode: "account",
			progress: { percentComplete: 50 },
		});
		expect(client.deviceProgress.getCourse("course-1")).toBeNull();
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			"/_emdash/api/plugins/lms-core/learning:complete-lesson",
		);
		expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
			'{"lessonId":"lesson-1","operationId":"00000000-0000-4000-8000-000000000001"}',
		);
	});

	it.each([401, 403])(
		"falls back to device progress only for an unauthenticated/unauthorized learner (%s)",
		async (status) => {
			const fetcher = vi.fn<typeof fetch>();
			fetcher.mockResolvedValue(
				response({ error: { code: "UNAUTHORIZED", message: "Sign in required." } }, status),
			);
			const client = createLearnBrowserClient({
				storage: storage(),
				fetch: fetcher,
				nextOperationId: () => "00000000-0000-4000-8000-000000000001",
			});

			await expect(
				client.completeLesson({ courseId: "course-1", lessonId: "lesson-1" }),
			).resolves.toMatchObject({
				mode: "device",
				progress: { completedLessonIds: ["lesson-1"] },
			});
		},
	);

	it("imports device lesson completions into the verified account without sending self-checks", async () => {
		const fetcher = vi.fn<typeof fetch>();
		fetcher.mockResolvedValue(
			response({
				data: {
					importedLessons: 1,
					importedLessonIds: ["lesson-1"],
					ignoredLessons: 0,
					progress: {
						courseId: "course-1",
						totalLessons: 1,
						completedLessons: 1,
						percentComplete: 100,
					},
				},
			}),
		);
		const client = createLearnBrowserClient({
			storage: storage(),
			fetch: fetcher,
			nextOperationId: () => "00000000-0000-4000-8000-000000000002",
		});
		client.deviceProgress.completeLesson("course-1", "lesson-1");
		client.deviceProgress.recordSelfCheck("course-1", {
			checkId: "check-1",
			revisionId: "revision-1",
			score: 100,
			passed: true,
		});

		await expect(client.importDeviceProgress("course-1")).resolves.toMatchObject({
			importedLessons: 1,
		});
		expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
			'{"courseId":"course-1","lessonIds":["lesson-1"],"operationId":"00000000-0000-4000-8000-000000000002"}',
		);
	});

	it("does not hide server failures behind local progress", async () => {
		const fetcher = vi.fn<typeof fetch>();
		fetcher.mockResolvedValue(
			response({ error: { code: "LEARN_SETUP_INCOMPLETE", message: "Run setup." } }, 409),
		);
		const client = createLearnBrowserClient({
			storage: storage(),
			fetch: fetcher,
		});

		await expect(
			client.completeLesson({ courseId: "course-1", lessonId: "lesson-1" }),
		).rejects.toBeInstanceOf(LearnBrowserApiError);
		expect(client.deviceProgress.getCourse("course-1")).toBeNull();
	});

	it("exposes verified progress and account-data erasure without identity fields", async () => {
		const fetcher = vi.fn<typeof fetch>();
		fetcher
			.mockResolvedValueOnce(
				response({
					data: {
						courseId: "course-1",
						totalLessons: 2,
						completedLessons: 1,
						percentComplete: 50,
					},
				}),
			)
			.mockResolvedValueOnce(
				response({
					data: {
						deleted: {
							lessonCompletions: 1,
							assessmentAttempts: 2,
							rawEngagementObservations: 3,
						},
					},
				}),
			);
		const client = createLearnBrowserClient({
			storage: storage(),
			fetch: fetcher,
		});

		await expect(client.getCourseProgress("course-1")).resolves.toMatchObject({
			percentComplete: 50,
		});
		await expect(client.eraseMyData()).resolves.toMatchObject({
			deleted: { lessonCompletions: 1, assessmentAttempts: 2 },
		});
		expect(fetcher.mock.calls.map((call) => call[1]?.body)).toEqual([
			'{"courseId":"course-1"}',
			"{}",
		]);
	});

	it("exposes partial-erasure details so the host can recover safely", async () => {
		const fetcher = vi.fn<typeof fetch>();
		fetcher.mockResolvedValue(
			response(
				{
					error: {
						code: "LEARN_PRIVACY_ERASURE_FAILED",
						message: "Some learner data could not be erased. The request can be retried safely.",
						details: {
							failedCategories: ["assessmentAttempts"],
							deleted: {
								lessonCompletions: 3,
								assessmentAttempts: 0,
								rawEngagementObservations: 5,
							},
						},
					},
				},
				500,
			),
		);
		const client = createLearnBrowserClient({
			storage: storage(),
			fetch: fetcher,
		});

		await expect(client.eraseMyData()).rejects.toMatchObject({
			name: "LearnBrowserApiError",
			code: "LEARN_PRIVACY_ERASURE_FAILED",
			status: 500,
			details: {
				failedCategories: ["assessmentAttempts"],
				deleted: {
					lessonCompletions: 3,
					assessmentAttempts: 0,
					rawEngagementObservations: 5,
				},
			},
		});
	});
});

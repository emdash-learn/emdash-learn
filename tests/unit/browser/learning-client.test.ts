import { describe, expect, it, vi } from "vitest";

import { createLearnBrowserClient } from "../../../src/browser/learning-client.js";
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

	it("normalizes long caller-supplied trailing slash suffixes in linear time", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ data: { accepted: true } }));
		const client = createLearnBrowserClient({
			storage: storage(),
			fetch: fetcher,
			baseUrl: `/custom/learn${"/".repeat(100_000)}`,
		});

		await client.observeCourseOpened("course-1");

		expect(fetcher).toHaveBeenCalledWith(
			"/custom/learn/engagement:observe",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("records Lesson completion only in bounded browser storage", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const client = createLearnBrowserClient({
			storage: storage(),
			fetch: fetcher,
		});

		await expect(
			client.completeLesson({ courseId: "course-1", lessonId: "lesson-1" }),
		).resolves.toMatchObject({
			mode: "device",
			progress: { completedLessonIds: ["lesson-1"] },
		});
		expect(fetcher).not.toHaveBeenCalled();
		expect(client.deviceProgress.getCourse("course-1")).toMatchObject({
			completedLessonIds: ["lesson-1"],
		});
	});
});

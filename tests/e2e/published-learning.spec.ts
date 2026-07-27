import { expect, test } from "@playwright/test";

const DEVICE_PROGRESS_KEY = "emdash-learn:device-progress:v1";

test.describe("published course reader", () => {
	test("browses the catalog, course outline, and lesson without signing in", async ({ page }) => {
		await page.goto("/catalog");

		const catalog = page.getByTestId("course-catalog");
		await expect(catalog).toBeVisible();
		await expect(catalog).toContainText("Course Publishing Essentials");
		await expect(catalog).toContainText("Course Design Lab");
		await expect(catalog).not.toContainText("Unpublished Course Draft");

		const courseOpened = page.waitForRequest(
			(request) =>
				request.url().endsWith("/engagement:observe") &&
				request.postDataJSON().type === "course_opened",
			{ timeout: 10_000 },
		);
		await page.getByRole("link", { name: "Course Publishing Essentials", exact: true }).click();
		const courseOpenedRequest = await courseOpened;
		expect(courseOpenedRequest.postDataJSON()).toMatchObject({
			type: "course_opened",
			courseId: expect.any(String),
		});

		const lessons = page.getByTestId("published-lessons");
		await expect(lessons).toContainText("Shape a course");
		await expect(lessons).toContainText("Publish with confidence");
		await expect(lessons).not.toContainText("Draft lesson not public");

		const lessonOpened = page.waitForRequest(
			(request) =>
				request.url().endsWith("/engagement:observe") &&
				request.postDataJSON().type === "lesson_opened",
			{ timeout: 10_000 },
		);
		await page.getByRole("link", { name: /1\. Shape a course/ }).click();
		expect((await lessonOpened).postDataJSON()).toMatchObject({
			type: "lesson_opened",
			courseId: expect.any(String),
			lessonId: expect.any(String),
		});
		await expect(page.getByRole("heading", { name: "Shape a course", exact: true })).toBeVisible();
		await expect(page.getByTestId("lesson-body")).toContainText(
			"Start with the outcome a reader should reach",
		);
	});

	test("keeps anonymous lesson completion on this device without creating an account record", async ({
		page,
	}) => {
		const serverCompletionStatuses: number[] = [];
		page.on("response", (response) => {
			if (response.url().endsWith("/learning:complete-lesson")) {
				serverCompletionStatuses.push(response.status());
			}
		});

		await page.goto("/courses/course-publishing-essentials");
		await page.getByRole("link", { name: /1\. Shape a course/ }).click();

		const progress = page.getByTestId("device-progress");
		const complete = progress.getByRole("button", {
			name: "Mark lesson complete",
		});
		await expect(progress).toContainText("Not completed on this device.");
		await expect(progress).toContainText(
			"Stored in this browser only. This is not an EmDash account learning record.",
		);

		await complete.click();
		await expect(progress).toContainText("Completed on this device.");
		expect(serverCompletionStatuses).toEqual([401]);

		const saved = await page.evaluate((storageKey) => {
			const value = localStorage.getItem(storageKey);
			return value === null ? null : JSON.parse(value);
		}, DEVICE_PROGRESS_KEY);
		expect(saved).toMatchObject({
			version: 1,
			courses: [
				{
					completedLessonIds: [expect.any(String)],
					selfChecks: [],
				},
			],
		});

		await page.reload();
		await expect(page.getByTestId("device-progress")).toContainText("Completed on this device.");
		await expect(page.getByRole("button", { name: "Completed on this device" })).toBeDisabled();
	});

	test("does not expose a draft course URL", async ({ page }) => {
		const response = await page.goto("/courses/unpublished-course-draft");
		expect(response?.status()).toBe(404);
		await expect(page.getByText("Published course not found")).toBeVisible();
	});
});

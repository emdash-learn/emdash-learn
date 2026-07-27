import { expect, test } from "@playwright/test";

const CHECK_ID = "check_demo_publishing_basics";
const DEVICE_PROGRESS_KEY = "emdash-learn:device-progress:v1";

test.describe("anonymous Knowledge Check", () => {
	test("presents the published revision and saves a self-check only on this device", async ({
		page,
	}) => {
		const assessmentRequests: string[] = [];
		page.on("request", (request) => {
			const route = new URL(request.url()).pathname.split("/").at(-1);
			if (route?.startsWith("assessment:")) assessmentRequests.push(route);
		});

		await page.goto("/courses/course-publishing-essentials");
		await page.getByRole("link", { name: /2\. Publish with confidence/ }).click();

		const check = page.getByTestId("knowledge-check");
		await expect(check).toBeVisible();
		await expect(check).toContainText("Publishing basics");
		const courseId = await check.getAttribute("data-course-id");
		expect(courseId).toEqual(expect.any(String));

		const presentation = await page.request.post(
			"/_emdash/api/plugins/lms-core/assessment:present",
			{
				data: { courseId, checkId: CHECK_ID },
				headers: { "X-EmDash-Request": "1" },
			},
		);
		expect(presentation.status()).toBe(200);
		await expect(presentation.json()).resolves.toMatchObject({
			data: {
				courseId,
				checkId: CHECK_ID,
				revisionId: "revision_demo_publishing_basics_v1",
				title: "Publishing basics",
				questions: [
					{ id: "public-boundary", type: "single_choice" },
					{ id: "device-result", type: "true_false" },
				],
			},
		});

		await check.getByLabel("Published courses").check();
		await check.getByLabel("False").check();

		const gradeResponse = page.waitForResponse((response) =>
			response.url().endsWith("/assessment:self-grade"),
		);
		await check.getByTestId("check-submit").click();
		expect((await gradeResponse).status()).toBe(200);

		const result = check.getByTestId("check-result");
		await expect(result).toBeVisible();
		await expect(result).toHaveAttribute("data-passed", "true");
		await expect(result).toContainText("100% — Passed");
		await expect(result).toContainText("Self-check saved only on this device.");
		expect(assessmentRequests).toContain("assessment:submit-attempt");
		expect(assessmentRequests).toContain("assessment:self-grade");

		const saved = await page.evaluate((storageKey) => {
			const value = localStorage.getItem(storageKey);
			return value === null ? null : JSON.parse(value);
		}, DEVICE_PROGRESS_KEY);
		expect(saved).toMatchObject({
			version: 1,
			courses: [
				{
					selfChecks: [
						{
							checkId: CHECK_ID,
							revisionId: "revision_demo_publishing_basics_v1",
							score: 100,
							passed: true,
						},
					],
				},
			],
		});

		await page.reload();
		await expect
			.poll(() =>
				page.evaluate((storageKey) => localStorage.getItem(storageKey), DEVICE_PROGRESS_KEY),
			)
			.not.toBeNull();
	});
});

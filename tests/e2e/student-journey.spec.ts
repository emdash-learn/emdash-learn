import { expect, test } from "@playwright/test";

/**
 * End-to-end student flow modeled after §18.7: authenticate via dev-bypass,
 * enroll in Course A, complete one lesson, and verify the enrollment shows
 * up on /my-learning with non-zero progress.
 *
 * Emdash's dev-bypass (as of emdash@0.5.x) always creates/uses the dev
 * admin user `dev@emdash.local` — `asUser` is not honored. We rely on that
 * admin account for the student flow; the §25 seed keeps Alice/Jon/Lin
 * fixtures for DB shape but doesn't tie the E2E caller to them.
 */

test.describe("student journey — admin-as-student", () => {
	test("enroll → complete a lesson → see it in /my-learning", async ({ page }) => {
		// Two-step auth: hit dev-bypass to set the session cookie, then navigate
		// to the course page explicitly. Following dev-bypass's meta-refresh
		// inside `page.goto` is flaky — the URL can settle before the refresh
		// actually fires, leaving the browser on the intermediate HTML page.
		await page.goto("/_emdash/api/auth/dev-bypass");
		await page.goto("/courses/getting-started-with-react");

		// Drive the enroll POST through page.evaluate so we can await the fetch
		// and the reload deterministically. The inline click handler also does
		// a reload, but Playwright races the two otherwise.
		const enrollButton = page.getByTestId("enroll-btn");
		if (await enrollButton.isVisible()) {
			const courseId = await enrollButton.getAttribute("data-course-id");
			const status = await page.evaluate(async (cid) => {
				const res = await fetch("/_emdash/api/plugins/lms-core/enroll", {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
					credentials: "same-origin",
					body: JSON.stringify({ courseId: cid, source: "free" }),
				});
				return res.status;
			}, courseId);
			// 200 = enrolled just now, 409 = already enrolled (previous run).
			expect([200, 409]).toContain(status);
			await page.reload();
		}
		await expect(page.getByTestId("enrolled-banner")).toBeVisible();

		// Open the first lesson. "Intro to React" is both first and a free
		// preview, so it's unlocked regardless of drip state.
		await page.getByRole("link", { name: "Intro to React", exact: true }).click();

		// Lesson A1 has no quiz block, so "Mark complete" is the lesson's
		// completion path.
		const complete = page.getByTestId("complete-btn");
		await expect(complete).toBeVisible();
		await complete.click();
		await expect(complete).toContainText("Completed");

		// /my-learning surfaces the enrollment + progress for the signed-in user.
		await page.goto("/my-learning");
		const card = page.getByTestId("my-course").first();
		await expect(card).toBeVisible();
		await expect(card).toContainText("Getting Started with React");
		await expect(card).not.toContainText("0% complete");
	});
});

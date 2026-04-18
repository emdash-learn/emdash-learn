import { expect, test } from "@playwright/test";

/**
 * Quiz flow: enter the seeded quiz on Lesson 3 of Course A, submit a failing
 * attempt, click the retry link, submit a passing attempt.
 *
 * §25 seed's quiz questions (by id):
 *   q1 (b correct), q2 (a correct), q3 (b correct), q4 (b correct)
 */

const WRONG_ANSWERS: Record<string, string> = {
	q1: "a",
	q2: "b",
	q3: "d",
	q4: "c",
};
const RIGHT_ANSWERS: Record<string, string> = {
	q1: "b",
	q2: "a",
	q3: "b",
	q4: "b",
};

async function fillAnswers(
	page: import("@playwright/test").Page,
	answers: Record<string, string>,
): Promise<void> {
	for (const [qid, optId] of Object.entries(answers)) {
		// Each fieldset has data-q-id and each radio's name is the question id
		// — scoping by name avoids cross-question collisions when ids are
		// reused across questions (the seed uses a/b/c/d per question).
		await page
			.locator(`fieldset[data-q-id="${qid}"] input[type="radio"][value="${optId}"]`)
			.check();
	}
}

test.describe("quiz taking", () => {
	test("fail once, retry, pass", async ({ page }) => {
		// Two-step auth: hit dev-bypass to set the session cookie, then navigate
		// to the course page explicitly so we never race meta-refresh redirects.
		await page.goto("/_emdash/api/auth/dev-bypass");
		await page.goto("/courses/getting-started-with-react");
		const enroll = page.getByTestId("enroll-btn");
		if (await enroll.isVisible()) {
			const courseId = await enroll.getAttribute("data-course-id");
			const status = await page.evaluate(async (cid) => {
				const res = await fetch("/_emdash/api/plugins/lms-core/enroll", {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
					credentials: "same-origin",
					body: JSON.stringify({ courseId: cid, source: "free" }),
				});
				return res.status;
			}, courseId);
			expect([200, 409]).toContain(status);
			await page.reload();
		}
		await expect(page.getByTestId("enrolled-banner")).toBeVisible();

		// Navigate to lesson 3 (Components) which carries the quiz block.
		await page.getByRole("link", { name: "Components", exact: true }).click();
		const quizBlock = page.getByTestId("quiz-block");
		await expect(quizBlock).toBeVisible();

		// "Start quiz →" link inside the quiz block.
		await quizBlock.getByRole("link", { name: /start quiz/i }).click();

		// -- First attempt: fail --
		await fillAnswers(page, WRONG_ANSWERS);
		await page.getByTestId("quiz-submit").click();
		const result = page.getByTestId("quiz-result");
		await expect(result).toBeVisible();
		await expect(result).toHaveAttribute("data-passed", "false");
		await expect(result).toContainText(/did not pass/i);

		// Retry link starts a fresh attempt on the same quiz page.
		await result.getByRole("link", { name: /try again/i }).click();

		// -- Second attempt: pass --
		await fillAnswers(page, RIGHT_ANSWERS);
		await page.getByTestId("quiz-submit").click();
		const secondResult = page.getByTestId("quiz-result");
		await expect(secondResult).toBeVisible();
		await expect(secondResult).toHaveAttribute("data-passed", "true");
		await expect(secondResult).toContainText(/passed/i);
	});
});

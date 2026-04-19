import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

/**
 * `requires_previous` gating within a lesson's topic list (ADR 0001). The
 * §25 demo seed wires lesson "Components" with three topics:
 *   1. JSX syntax (no requires_previous)
 *   2. Props      (requires_previous=true)
 *   3. Children   (no requires_previous)
 *
 * This spec runs the demo seed at the start so prior specs in the same
 * Playwright run can't leak progress that pre-unlocks Props.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test.describe("topic gating — requires_previous within a lesson", () => {
	test.beforeAll(() => {
		// Re-seed to clear any leaked progress from earlier specs in the run.
		execSync("pnpm --filter ./demos/simple seed", { cwd: REPO_ROOT, stdio: "inherit" });
	});

	test("Props is locked until JSX syntax completes", async ({ page }) => {
		await page.goto("/_emdash/api/auth/dev-bypass");
		await page.goto("/courses/getting-started-with-react");

		const enrollButton = page.getByTestId("enroll-btn");
		if (await enrollButton.isVisible()) {
			const courseId = await enrollButton.getAttribute("data-course-id");
			await page.evaluate(async (cid) => {
				await fetch("/_emdash/api/plugins/lms-core/enroll", {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
					credentials: "same-origin",
					body: JSON.stringify({ courseId: cid, source: "free" }),
				});
			}, courseId);
			await page.reload();
		}

		await page.getByRole("link", { name: "Components", exact: true }).click();

		// Initial state: Props should NOT be a link (locked); JSX syntax IS.
		const topicsList = page.getByTestId("topics-list");
		await expect(topicsList).toBeVisible();
		const propsLink = topicsList.getByRole("link", { name: "Props", exact: true });
		await expect(propsLink).toHaveCount(0);
		await expect(topicsList.getByRole("link", { name: "JSX syntax", exact: true })).toBeVisible();

		// Complete JSX syntax.
		await page.getByRole("link", { name: "JSX syntax", exact: true }).click();
		const topicComplete = page.getByTestId("topic-complete-btn");
		await expect(topicComplete).toBeVisible();
		await topicComplete.click();
		await expect(topicComplete).toContainText("Completed");

		// Navigate back to the lesson with a fresh fetch so the SSR
		// curriculum reflects the new completion.
		await page.goBack();
		await page.reload();
		await expect(
			page.getByTestId("topics-list").getByRole("link", { name: "Props", exact: true }),
		).toBeVisible();
	});
});

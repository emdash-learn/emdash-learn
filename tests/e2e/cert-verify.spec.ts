import { expect, test } from "@playwright/test";

/**
 * §6.2 `certificate:verify` is a public route. The §25 seed produces a cert
 * for Lin + Course A with verificationCode=LEARN-DEMO-LIN-A.
 */

test.describe("certificate verification", () => {
	test("renders a valid certificate on a real code", async ({ page }) => {
		await page.goto("/certificates/LEARN-DEMO-LIN-A");
		const banner = page.getByTestId("cert-valid");
		await expect(banner).toBeVisible();
		await expect(banner).toContainText("Valid certificate");
		await expect(banner).toContainText("Lin Nguyen");
		await expect(banner).toContainText("Getting Started with React");
	});

	test("renders the invalid state on an unknown code", async ({ page }) => {
		await page.goto("/certificates/NOT-A-REAL-CODE");
		const banner = page.getByTestId("cert-invalid");
		await expect(banner).toBeVisible();
		await expect(banner).toContainText("not valid");
	});
});

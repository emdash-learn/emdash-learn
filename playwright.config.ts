import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config. The webServer boots the demo site's Astro dev server
 * against a freshly seeded data.db (globalSetup runs the §25 seed).
 *
 * Tests never hardcode port 4321 elsewhere — they read `baseURL` via the
 * `use` option. `E2E_BASE_URL` lets CI override both baseURL + webServer.
 */
export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: false,
	// Each spec uses dev-bypass → admin session; running serially keeps the
	// filesystem session store + seeded DB clean across files.
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	reporter: process.env.CI ? "github" : "list",
	globalSetup: "./tests/e2e/global-setup.ts",
	use: {
		baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4321",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
	},
	webServer: process.env.E2E_BASE_URL
		? undefined
		: {
				command: "pnpm --filter ./demos/simple dev",
				url: "http://localhost:4321",
				reuseExistingServer: !process.env.CI,
				timeout: 120_000,
				stdout: "pipe",
				stderr: "pipe",
			},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});

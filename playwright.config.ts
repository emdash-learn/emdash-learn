import { defineConfig, devices } from "@playwright/test";

const localPort = process.env["E2E_PORT"] ?? "4322";
if (!/^\d{2,5}$/u.test(localPort) || Number(localPort) < 1024 || Number(localPort) > 65_535) {
	throw new Error("E2E_PORT must be an unprivileged TCP port.");
}
const localBaseUrl = `http://localhost:${localPort}`;
const baseUrl = process.env["E2E_BASE_URL"] ?? localBaseUrl;

/**
 * Playwright config. The webServer boots the demo site's Astro dev server
 * against a freshly seeded data.db (globalSetup runs the §25 seed).
 *
 * Tests read `baseURL` from the config. A strict dedicated port prevents
 * Playwright from silently reusing an unrelated local Astro server.
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
		baseURL: baseUrl,
		trace: "on-first-retry",
		screenshot: "only-on-failure",
	},
	webServer: process.env.E2E_BASE_URL
		? undefined
		: {
				command:
					`ASTRO_DEV_BACKGROUND=0 EMDASH_LEARN_SITE_URL=${localBaseUrl} ` +
					`pnpm --filter ./demos/simple exec astro dev --force --port ${localPort} --strictPort`,
				url: localBaseUrl,
				reuseExistingServer: false,
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

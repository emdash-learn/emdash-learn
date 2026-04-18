/**
 * Playwright globalSetup: wipe + re-seed the demo DB before every test run so
 * suites start from the §25 fixtures. The seed script is idempotent, so this
 * is safe even when `reuseExistingServer: true` left a previous DB behind.
 */

import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "..", "..");

export default async function globalSetup(): Promise<void> {
	// Run the §25 seed. It's idempotent — wipes seeded rows (content + plugin
	// storage) in place without touching the DB file, so any running Astro dev
	// server keeps its open handle. Do NOT `rmSync` the DB: SQLite's
	// `SQLITE_READONLY_DBMOVED` fires if the file is replaced under a live
	// connection, breaking every subsequent write until restart.
	execSync("pnpm --filter ./demos/simple seed", {
		cwd: REPO_ROOT,
		stdio: "inherit",
	});
}

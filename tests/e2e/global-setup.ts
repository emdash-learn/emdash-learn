/** Re-seed the anonymous publishing fixture before every browser run. */

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "..", "..");

export default async function globalSetup(): Promise<void> {
	const authenticatedJourneys = process.env["E2E_AUTHENTICATED"] === "1";
	if (authenticatedJourneys) {
		process.env["EMDASH_LEARN_E2E_SECONDARY_TOKEN"] =
			`ec_pat_${randomBytes(32).toString("base64url")}`;
	}
	// The seed updates rows in place without replacing the database file, so a
	// reused Astro server keeps a valid SQLite handle. Do not remove data.db:
	// SQLite's
	// `SQLITE_READONLY_DBMOVED` fires if the file is replaced under a live
	// connection, breaking every subsequent write until restart.
	execSync("pnpm --filter ./demos/simple seed", {
		cwd: REPO_ROOT,
		stdio: "inherit",
		env: {
			...process.env,
			EMDASH_LEARN_E2E_START_UNCONFIGURED: authenticatedJourneys ? "1" : "0",
		},
	});
}

import assert from "node:assert/strict";
import test from "node:test";

import { validatePullRequestPolicy } from "./repository-policy.mjs";

void test("feature work targets develop", () => {
	assert.deepEqual(
		validatePullRequestPolicy({ head: "feature/report-export", base: "develop" }),
		[],
	);
	assert.match(
		validatePullRequestPolicy({ head: "feature/report-export", base: "main" })[0],
		/must target "develop"/u,
	);
});

void test("release and hotfix branches target main", () => {
	assert.deepEqual(validatePullRequestPolicy({ head: "release/0.1.0", base: "main" }), []);
	assert.deepEqual(validatePullRequestPolicy({ head: "hotfix/0.1.1", base: "main" }), []);
	assert.match(
		validatePullRequestPolicy({ head: "release/0.1.0", base: "develop" })[0],
		/must target "main"/u,
	);
});

void test("main may be synchronized back into develop", () => {
	assert.deepEqual(validatePullRequestPolicy({ head: "main", base: "develop" }), []);
});

void test("automation branches target develop", () => {
	assert.deepEqual(
		validatePullRequestPolicy({ head: "changeset-release/develop", base: "develop" }),
		[],
	);
	assert.deepEqual(
		validatePullRequestPolicy({ head: "dependabot/npm_and_yarn/react-20", base: "develop" }),
		[],
	);
});

void test("unstructured and incomplete branch pairs are rejected", () => {
	assert.match(
		validatePullRequestPolicy({ head: "my-work", base: "develop" })[0],
		/does not match/u,
	);
	assert.match(validatePullRequestPolicy({ head: "", base: "develop" })[0], /required/u);
});

const STANDARD_BRANCH =
	/^(build|chore|ci|docs|feature|fix|perf|refactor|test)\/[a-z0-9][a-z0-9._-]*$/u;
const VERSION_BRANCH = /^(release|hotfix)\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const AUTOMATION_BRANCH = /^(changeset-release\/develop|dependabot\/.+)$/u;

export function validatePullRequestPolicy({ head, base }) {
	const errors = [];
	if (!head || !base) return ["Both the pull request head and base branches are required."];

	if (head === "main" && base === "develop") return [];

	if (VERSION_BRANCH.test(head)) {
		if (base !== "main") {
			errors.push(`Gitflow branch "${head}" must target "main", not "${base}".`);
		}
		return errors;
	}

	if (STANDARD_BRANCH.test(head) || AUTOMATION_BRANCH.test(head)) {
		if (base !== "develop") {
			errors.push(`Gitflow branch "${head}" must target "develop", not "${base}".`);
		}
		return errors;
	}

	errors.push(
		`Branch "${head}" does not match the Gitflow naming policy. ` +
			"Use feature/, fix/, release/, hotfix/, docs/, chore/, refactor/, test/, ci/, build/, or perf/.",
	);
	return errors;
}

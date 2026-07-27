import { validatePullRequestPolicy } from "./repository-policy.mjs";

const [head = process.env.GITHUB_HEAD_REF, base = process.env.GITHUB_BASE_REF] =
	process.argv.slice(2);
const errors = validatePullRequestPolicy({ head, base });

if (errors.length > 0) {
	for (const error of errors) console.error(`::error::${error}`);
	process.exitCode = 1;
} else {
	console.log(`Gitflow policy accepted: ${head} -> ${base}`);
}

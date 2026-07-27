import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { createLinter } from "actionlint";

const workflowsDirectory = path.resolve(".github/workflows");
const workflowFiles = (await readdir(workflowsDirectory))
	.filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
	.toSorted();
const lint = await createLinter();
let failures = 0;

const workflows = await Promise.all(
	workflowFiles.map(async (file) => ({
		relativePath: path.posix.join(".github/workflows", file),
		contents: await readFile(path.join(workflowsDirectory, file), "utf8"),
	})),
);

for (const { contents, relativePath } of workflows) {
	for (const result of lint(contents, relativePath)) {
		failures += 1;
		console.error(
			`${result.file}:${result.line}:${result.column}: ${result.message} [${result.kind}]`,
		);
	}
}

if (failures > 0) {
	process.exitCode = 1;
} else {
	console.log(`Validated ${workflowFiles.length} GitHub Actions workflows.`);
}

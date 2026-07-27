import { createRequire } from "node:module";
import { defineConfig } from "tsdown";

const require = createRequire(import.meta.url);
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- JSON.parse returns any
const { version } = require("./package.json") as { version: string };

export default defineConfig({
	entry: ["src/index.ts", "src/sandbox-entry.ts", "src/admin.tsx", "src/browser/index.ts"],
	format: "esm",
	dts: true,
	clean: true,
	deps: {
		neverBundle: ["emdash", "astro", "react", "react-dom", "react/jsx-runtime"],
	},
	define: {
		// Replaced at build time so PLUGIN_VERSION always matches package.json.
		__PLUGIN_VERSION__: JSON.stringify(version),
	},
});

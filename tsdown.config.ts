import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/sandbox-entry.ts", "src/admin.tsx"],
	format: "esm",
	dts: true,
	clean: true,
	external: ["emdash", "astro", "react", "react-dom", "react/jsx-runtime"],
});

import node from "@astrojs/node";
import react from "@astrojs/react";
import { lmsCorePlugin } from "@emdash/lms-core";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			plugins: [lmsCorePlugin()],
		}),
	],
});

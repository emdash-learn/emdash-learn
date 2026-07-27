import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import node from "@astrojs/node";
import react from "@astrojs/react";
import { lmsCorePlugin } from "@emdash/lms-core";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			siteUrl: process.env.EMDASH_LEARN_SITE_URL,
			plugins: [lmsCorePlugin()],
		}),
	],
	vite: {
		server: {
			fs: {
				allow: [resolve(__dirname, "../.."), resolve(__dirname, "../../../emdash")],
			},
		},
	},
});

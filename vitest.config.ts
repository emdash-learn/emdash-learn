import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: [
			"tests/unit/**/*.test.ts",
			"tests/integration/**/*.test.ts",
			// T04's fixture smoke test lives at a non-`.test.ts` path per §26.
			"tests/integration/utils/self-test.ts",
		],
		exclude: ["tests/e2e/**", "node_modules/**", "dist/**", "demos/**"],
		environment: "node",
		globals: false,
		clearMocks: true,
		restoreMocks: true,
	},
});

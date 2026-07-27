import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const DEMO_TYPES = new URL("../../demos/simple/emdash-env.d.ts", import.meta.url);

describe("canonical demo scope", () => {
	it("keeps generated Learn types free of superseded LMS fields and collections", async () => {
		const types = await readFile(DEMO_TYPES, "utf8");
		const supersededDeclarations = [
			"trailer_url",
			"price_cents",
			"currency",
			"enrollment_open",
			"enrollment_opens_at",
			"enrollment_closes_at",
			"is_preview",
			"requires_previous",
			"drip_offset_days",
			"export interface Topic",
			"topics: Topic",
		];

		expect(supersededDeclarations.filter((declaration) => types.includes(declaration))).toEqual([]);
	});
});

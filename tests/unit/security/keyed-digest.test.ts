import { describe, expect, it } from "vitest";

import { createKeyedDigest, generateDigestSecret } from "../../../src/security/keyed-digest.js";

describe("keyed digest", () => {
	it("is stable, domain-separated, key-safe, and does not expose its input", async () => {
		const digest = createKeyedDigest("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

		const first = await digest("attempt-key", "learner@example.test:submission-1");
		const retry = await digest("attempt-key", "learner@example.test:submission-1");
		const otherDomain = await digest("engagement-actor", "learner@example.test:submission-1");

		expect(first).toBe(retry);
		expect(first).not.toBe(otherDomain);
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(first).not.toContain("learner");
	});

	it("generates a URL-safe 256-bit installation secret", () => {
		expect(generateDigestSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});
});

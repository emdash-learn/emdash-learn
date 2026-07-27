import { describe, expect, it } from "vitest";

import { createPublicRateLimiter } from "../../../src/security/public-rate-limit.js";

describe("public observation rate limiter", () => {
	it("limits a redacted request fingerprint within a fixed window", async () => {
		let now = 1_000;
		const limiter = createPublicRateLimiter({
			now: () => now,
			digest: async (_domain, value) => `digest:${value}`,
			limit: 2,
			windowMs: 60_000,
		});
		const request = { ip: "192.0.2.10" };

		await limiter.check(request);
		await limiter.check(request);
		await expect(limiter.check(request)).rejects.toMatchObject({
			code: "LEARN_RATE_LIMITED",
			status: 429,
		});

		now += 60_000;
		await expect(limiter.check(request)).resolves.toBeUndefined();
	});

	it("does not mix distinct request fingerprints", async () => {
		const limiter = createPublicRateLimiter({
			now: () => 1_000,
			digest: async (_domain, value) => `digest:${value}`,
			limit: 1,
			windowMs: 60_000,
		});

		await limiter.check({ ip: "192.0.2.10" });
		await expect(limiter.check({ ip: "192.0.2.11" })).resolves.toBeUndefined();
	});

	it("does not let User-Agent rotation reset a trusted-IP budget", async () => {
		const limiter = createPublicRateLimiter({
			now: () => 1_000,
			digest: async (_domain, value) => `digest:${value}`,
			limit: 1,
			windowMs: 60_000,
		});
		const chrome = { ip: "192.0.2.10", userAgent: "Chrome" };
		const firefox = { ip: "192.0.2.10", userAgent: "Firefox" };

		await limiter.check(chrome);
		await expect(limiter.check(firefox)).rejects.toMatchObject({
			code: "LEARN_RATE_LIMITED",
			status: 429,
		});
	});

	it("uses one installation fallback budget when no trusted IP is available", async () => {
		const limiter = createPublicRateLimiter({
			now: () => 1_000,
			digest: async (_domain, value) => `digest:${value}`,
			limit: 1,
			windowMs: 60_000,
		});
		const chrome = { ip: null, userAgent: "Chrome" };
		const firefox = { ip: null, userAgent: "Firefox" };

		await limiter.check(chrome);
		await expect(limiter.check(firefox)).rejects.toMatchObject({
			code: "LEARN_RATE_LIMITED",
			status: 429,
		});
	});
});

import { describe, expect, it, vi } from "vitest";

import {
	ensureInstallationDigestSecret,
	requireInstallationDigest,
} from "../../../src/security/installation-digest.js";

describe("installation digest", () => {
	it("creates the secret once during setup and reuses it", async () => {
		let value: unknown = null;
		const kv = {
			get: vi.fn(async () => value),
			set: vi.fn(async (_key: string, next: unknown) => {
				value = next;
			}),
		};

		const first = await ensureInstallationDigestSecret(kv);
		const second = await ensureInstallationDigestSecret(kv);

		expect(first).toBe(second);
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(kv.set).toHaveBeenCalledTimes(1);
	});

	it("fails closed when a request runs before the installation secret exists", async () => {
		const kv = {
			get: async () => null,
		};

		await expect(requireInstallationDigest(kv)).rejects.toMatchObject({
			code: "LEARN_SETUP_INCOMPLETE",
			status: 409,
		});
	});
});

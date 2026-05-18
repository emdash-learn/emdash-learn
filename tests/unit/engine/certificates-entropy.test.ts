/**
 * Unit test: `generateVerificationCode` entropy (AUDIT C2).
 *
 * Generates 10_000 codes and verifies Shannon entropy per character position
 * exceeds 4.9 bits (theoretical max for 32-symbol alphabet is log2(32) = 5.0).
 * A biased RNG (e.g. Math.random + modulo) would score noticeably lower.
 */

import { describe, expect, it } from "vitest";

// Re-export the private helper by exercising the public `issue` surface —
// we generate codes via `issue()` and read them back, avoiding any need to
// export the internal `generateVerificationCode` function.
import * as certificates from "../../../src/engine/certificates.js";
import { createTestPluginCtx } from "../../utils/test-plugin-ctx.js";

function shannonEntropy(counts: Map<string, number>, total: number): number {
	let entropy = 0;
	for (const count of counts.values()) {
		const p = count / total;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

describe("generateVerificationCode entropy", () => {
	it("Shannon entropy per character position exceeds 4.9 bits across 10_000 codes", async () => {
		const N = 10_000;
		const codes: string[] = [];

		// Batch issues to avoid unique-index conflicts: use distinct (user, course) pairs.
		const { ctx, teardown } = await createTestPluginCtx();
		try {
			// Sequential by design — 10_000 concurrent SQLite writes would exhaust the pool.
			// eslint-disable-next-line no-await-in-loop
			for (let i = 0; i < N; i++) {
				// eslint-disable-next-line no-await-in-loop
				const result = await certificates.issue(ctx, `u_ent_${i}`, `c_ent_${i}`);
				if (!result.ok) throw new Error(`issue failed at i=${i}: ${result.error.message}`);
				codes.push(result.data.data.verificationCode);
			}
		} finally {
			await teardown();
		}

		expect(codes.length).toBe(N);

		// Check entropy for each of the 12 character positions.
		for (let pos = 0; pos < 12; pos++) {
			const freq = new Map<string, number>();
			for (const code of codes) {
				const ch = code[pos]!;
				freq.set(ch, (freq.get(ch) ?? 0) + 1);
			}
			const entropy = shannonEntropy(freq, N);
			expect(entropy, `position ${pos} entropy`).toBeGreaterThan(4.9);
		}
	}, 120_000);
});

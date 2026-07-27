import type { KeyedDigest } from "./keyed-digest.js";

export interface PublicRequestFingerprint {
	ip: string | null;
}

export interface PublicRateLimiter {
	check(request: PublicRequestFingerprint): Promise<void>;
}

export interface PublicRateLimiterDependencies {
	now: () => number;
	digest: KeyedDigest;
	limit?: number;
	windowMs?: number;
	maxBuckets?: number;
}

export class PublicRateLimitError extends Error {
	readonly code = "LEARN_RATE_LIMITED";
	readonly status = 429;

	constructor() {
		super("Too many public Learn requests. Try again shortly.");
		this.name = "PublicRateLimitError";
	}
}

interface Bucket {
	windowStartedAt: number;
	count: number;
}

export function createPublicRateLimiter(
	dependencies: PublicRateLimiterDependencies,
): PublicRateLimiter {
	const limit = dependencies.limit ?? 120;
	const windowMs = dependencies.windowMs ?? 60_000;
	const maxBuckets = dependencies.maxBuckets ?? 10_000;
	const buckets = new Map<string, Bucket>();

	if (!Number.isInteger(limit) || limit < 1) throw new Error("Rate limit must be positive.");
	if (!Number.isInteger(windowMs) || windowMs < 1000) {
		throw new Error("Rate-limit window must be at least one second.");
	}
	if (!Number.isInteger(maxBuckets) || maxBuckets < 1) {
		throw new Error("Rate-limit bucket capacity must be positive.");
	}

	function prune(now: number): void {
		for (const [key, bucket] of buckets) {
			if (bucket.windowStartedAt + windowMs <= now) buckets.delete(key);
		}
		while (buckets.size >= maxBuckets) {
			const oldest = buckets.keys().next();
			if (oldest.done) break;
			buckets.delete(oldest.value);
		}
	}

	return {
		async check(request) {
			const now = dependencies.now();
			const key = await dependencies.digest(
				"public-rate-limit",
				request.ip ?? "installation-fallback",
			);
			const windowStartedAt = Math.floor(now / windowMs) * windowMs;
			const existing = buckets.get(key);
			if (!existing || existing.windowStartedAt !== windowStartedAt) {
				if (buckets.size >= maxBuckets) prune(now);
				buckets.set(key, { windowStartedAt, count: 1 });
				return;
			}
			if (existing.count >= limit) throw new PublicRateLimitError();
			existing.count += 1;
		},
	};
}

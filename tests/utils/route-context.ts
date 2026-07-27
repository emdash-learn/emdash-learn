import type { RouteContext } from "emdash";

import type { CoreRoutePrincipal } from "../../src/modules/learner-principal.js";

export function createRouteContext<TInput>(
	input: TInput,
	options: {
		principal?: CoreRoutePrincipal | null;
		method?: string;
		onWarn?: (message: string, data?: unknown) => void;
		storage?: RouteContext["storage"];
		kvValues?: Record<string, unknown>;
	} = {},
): RouteContext<TInput> & { principal: CoreRoutePrincipal | null } {
	const kvValues = new Map(Object.entries(options.kvValues ?? {}));
	return {
		plugin: { id: "lms-core", version: "0.0.0-test" },
		storage: options.storage ?? {},
		kv: {
			async get<T>(key: string) {
				const value = kvValues.get(key);
				// This typed test adapter owns the values supplied by each test.
				// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-owned values match the requested fixture type
				return value === undefined ? null : (structuredClone(value) as T);
			},
			async set(key, value) {
				kvValues.set(key, structuredClone(value));
			},
			async delete(key) {
				return kvValues.delete(key);
			},
			async list(prefix) {
				return [...kvValues.entries()]
					.filter(([key]) => prefix === undefined || key.startsWith(prefix))
					.map(([key, value]) => ({ key, value: structuredClone(value) }));
			},
		},
		log: {
			debug() {},
			info() {},
			warn: options.onWarn ?? (() => {}),
			error() {},
		},
		site: {
			name: "Learn test",
			url: "https://learn.example.test",
			locale: "en",
			trailingSlash: "ignore",
		},
		url: (path) => new URL(path, "https://learn.example.test").toString(),
		input,
		request: new Request("https://learn.example.test/_emdash/api/plugins/lms-core/test", {
			method: options.method ?? "POST",
		}),
		requestMeta: {
			ip: null,
			userAgent: null,
			referer: null,
			geo: null,
		},
		principal: options.principal ?? null,
	};
}

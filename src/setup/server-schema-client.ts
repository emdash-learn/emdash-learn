import type { RouteContext } from "emdash";

import { createCoreSchemaClient, type CoreSchemaClient } from "./core-schema-client.js";

export interface ServerCoreSchemaClientOptions {
	/** Overrides the network boundary in tests. */
	fetcher?: typeof fetch;
}

/**
 * Creates a schema client for a server-side plugin route while retaining the
 * authenticated Core session represented by that route's request. The target
 * origin comes from EmDash's configured site URL, never the request Host
 * header, because credentials are replayed across this internal HTTP boundary.
 */
export function createServerSchemaClient(
	ctx: RouteContext,
	options: ServerCoreSchemaClientOptions = {},
): CoreSchemaClient {
	const siteUrl = new URL(ctx.site.url);
	if (siteUrl.protocol !== "http:" && siteUrl.protocol !== "https:") {
		throw new TypeError("Server Core schema client requires an HTTP(S) configured site URL");
	}
	const baseUrl = siteUrl.origin;
	const sessionCookie = ctx.request.headers.get("cookie");
	const authorization = ctx.request.headers.get("authorization");
	const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);

	const authenticatedFetcher: typeof fetch = async (input, init) => {
		const headers = new Headers(init?.headers);
		if (sessionCookie !== null) headers.set("cookie", sessionCookie);
		if (authorization !== null) headers.set("authorization", authorization);
		return fetcher(input, { ...init, headers });
	};

	return createCoreSchemaClient({ baseUrl, fetcher: authenticatedFetcher });
}

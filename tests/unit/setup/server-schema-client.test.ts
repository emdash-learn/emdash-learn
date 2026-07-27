import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import { createServerSchemaClient } from "../../../src/setup/server-schema-client.js";
import { createRouteContext } from "../../utils/route-context.js";

interface RecordedRequest {
	url: string;
	init: RequestInit | undefined;
}

function recordingFetcher(
	requests: RecordedRequest[],
	data: unknown = { items: [] },
): typeof fetch {
	return async (input, init) => {
		requests.push({
			url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			init,
		});
		return Response.json({ data });
	};
}

function routeRequest(
	url: string,
	headers: HeadersInit = {},
	init: Omit<RequestInit, "headers"> = {},
	siteUrl = "https://cms.example",
): RouteContext {
	const base = createRouteContext(undefined);
	return {
		...base,
		site: { ...base.site, url: siteUrl },
		request: new Request(url, { ...init, headers }),
	};
}

describe("server Core schema client", () => {
	it("uses the configured Core origin and forwards its session cookie", async () => {
		const requests: RecordedRequest[] = [];
		const schema = createServerSchemaClient(
			routeRequest("https://cms.example/admin/plugins/learn/setup?step=collections", {
				cookie: "astro-session=session-value; d1-bookmark=bookmark-value",
			}),
			{ fetcher: recordingFetcher(requests) },
		);

		await expect(schema.listCollections()).resolves.toEqual([]);

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://cms.example/_emdash/api/schema/collections");
		const headers = new Headers(requests[0]?.init?.headers);
		expect(headers.get("cookie")).toBe("astro-session=session-value; d1-bookmark=bookmark-value");
		expect(headers.get("accept")).toBe("application/json");
		expect(headers.get("x-emdash-request")).toBe("1");
	});

	it("forwards the route's bearer authorization when Core authenticated it with a token", async () => {
		const requests: RecordedRequest[] = [];
		const schema = createServerSchemaClient(
			routeRequest("https://cms.example/plugins/learn/api/setup", {
				authorization: "Bearer core-api-token",
			}),
			{ fetcher: recordingFetcher(requests) },
		);

		await schema.listCollections();

		const headers = new Headers(requests[0]?.init?.headers);
		expect(headers.get("authorization")).toBe("Bearer core-api-token");
	});

	it("does not replay route metadata or its body and preserves Core's POST request", async () => {
		const requests: RecordedRequest[] = [];
		const collection = { slug: "courses", label: "Courses" };
		const responseCollection = {
			id: "collection-courses",
			...collection,
			labelSingular: null,
			description: null,
			icon: null,
			supports: [],
			source: null,
			urlPattern: null,
			hasSeo: false,
			commentsEnabled: false,
			commentsModeration: "first_time",
			commentsClosedAfterDays: 90,
			commentsAutoApproveUsers: true,
			createdAt: "2026-07-26T00:00:00.000Z",
			updatedAt: "2026-07-26T00:00:00.000Z",
		};
		const schema = createServerSchemaClient(
			routeRequest(
				"https://cms.example/_emdash/api/plugins/lms-core/setup",
				{
					accept: "text/html",
					authorization: "Bearer core-api-token",
					connection: "keep-alive",
					"content-length": "24",
					"content-type": "text/plain",
					cookie: "astro-session=session-value",
					host: "untrusted.example",
					origin: "https://untrusted.example",
					"proxy-authorization": "Basic proxy-credential",
					"transfer-encoding": "chunked",
					"x-forwarded-host": "untrusted.example",
					"x-emdash-request": "0",
					"x-plugin-metadata": "do-not-replay",
				},
				{ method: "POST", body: "untrusted route payload" },
			),
			{ fetcher: recordingFetcher(requests, { item: responseCollection }) },
		);

		await schema.createCollection(collection);

		expect(requests[0]?.url).toBe("https://cms.example/_emdash/api/schema/collections");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[0]?.init?.credentials).toBe("same-origin");
		expect(requests[0]?.init?.body).toBe(JSON.stringify(collection));
		expect(Object.fromEntries(new Headers(requests[0]?.init?.headers))).toEqual({
			accept: "application/json",
			authorization: "Bearer core-api-token",
			"content-type": "application/json",
			cookie: "astro-session=session-value",
			"x-emdash-request": "1",
		});
	});

	it("never forwards credentials to a request-derived origin", async () => {
		const requests: RecordedRequest[] = [];
		const schema = createServerSchemaClient(
			routeRequest("https://attacker.example/_emdash/api/plugins/lms-core/setup", {
				authorization: "Bearer core-api-token",
				cookie: "astro-session=session-value",
			}),
			{ fetcher: recordingFetcher(requests) },
		);

		await schema.listCollections();

		expect(requests[0]?.url).toBe("https://cms.example/_emdash/api/schema/collections");
		const headers = new Headers(requests[0]?.init?.headers);
		expect(headers.get("authorization")).toBe("Bearer core-api-token");
		expect(headers.get("cookie")).toBe("astro-session=session-value");
	});

	it.each(["data:text/plain,configured-site", "ftp://cms.example/"])(
		"fails closed for a non-HTTP configured site URL: %s",
		(siteUrl) => {
			expect(() =>
				createServerSchemaClient(
					routeRequest("https://cms.example/_emdash/api/plugins/lms-core/setup", {}, {}, siteUrl),
				),
			).toThrow("requires an HTTP(S) configured site URL");
		},
	);
});

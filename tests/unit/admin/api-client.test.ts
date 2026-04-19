/**
 * Unit tests for `src/admin/api-client.ts` (T18).
 *
 * Covers the transport contract (envelope, headers, CSRF), typed error surface
 * (`LmsApiError`), and route-name routing across the nested client.
 */

import { describe, expect, it, vi } from "vitest";

import { createApiClient, LmsApiError } from "../../../src/admin/api-client.js";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

function textResponse(text: string, init: ResponseInit = {}): Response {
	return new Response(text, {
		status: 200,
		headers: { "Content-Type": "text/plain" },
		...init,
	});
}

function makeClient(fetchMock: FetchMock) {
	return createApiClient({ fetch: fetchMock as unknown as typeof fetch });
}

describe("createApiClient", () => {
	it("unwraps `data` on a 2xx envelope and returns the inner value", async () => {
		const fetchMock: FetchMock = vi.fn(async () =>
			jsonResponse({ data: { state: { version: 1, completedSteps: [] }, targetVersion: 1 } }),
		);
		const api = makeClient(fetchMock);

		const res = await api.setup.state();
		expect(res).toEqual({
			state: { version: 1, completedSteps: [] },
			targetVersion: 1,
		});
	});

	it("throws LmsApiError with code + message + status on an error envelope", async () => {
		const fetchMock: FetchMock = vi.fn(async () =>
			jsonResponse(
				{ error: { code: "LEARN_NOT_ENROLLED", message: "not enrolled" } },
				{ status: 403 },
			),
		);
		const api = makeClient(fetchMock);

		let caught: unknown;
		try {
			await api.enrollments.unenroll({ enrollmentId: "enr_123" });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(LmsApiError);
		const err = caught as LmsApiError;
		expect(err.code).toBe("LEARN_NOT_ENROLLED");
		expect(err.message).toBe("not enrolled");
		expect(err.status).toBe(403);
	});

	it("maps a non-JSON response to NETWORK_ERROR", async () => {
		const fetchMock: FetchMock = vi.fn(async () =>
			textResponse("<html>502 Bad Gateway</html>", { status: 502 }),
		);
		const api = makeClient(fetchMock);

		await expect(api.setup.state()).rejects.toMatchObject({
			name: "LmsApiError",
			code: "NETWORK_ERROR",
			status: 502,
		});
	});

	it("maps a fetch rejection to NETWORK_ERROR with status 0", async () => {
		const fetchMock: FetchMock = vi.fn(async () => {
			throw new TypeError("Failed to fetch");
		});
		const api = makeClient(fetchMock);

		await expect(api.setup.state()).rejects.toMatchObject({
			name: "LmsApiError",
			code: "NETWORK_ERROR",
			status: 0,
			message: "Failed to fetch",
		});
	});

	it("sends X-EmDash-Request, JSON content type, and same-origin credentials", async () => {
		const fetchMock: FetchMock = vi.fn(async () =>
			jsonResponse({ data: { items: [], hasMore: false } }),
		);
		const api = makeClient(fetchMock);

		await api.catalog({ limit: 10 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/_emdash/api/plugins/lms-core/catalog");
		expect(init.method).toBe("POST");
		expect(init.credentials).toBe("same-origin");
		const headers = init.headers as Record<string, string>;
		expect(headers["X-EmDash-Request"]).toBe("1");
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers["Accept"]).toBe("application/json");
	});

	it("sends `{}` as body for input-less methods", async () => {
		const fetchMock: FetchMock = vi.fn(async () =>
			jsonResponse({ data: { state: { version: 0, completedSteps: [] }, targetVersion: 1 } }),
		);
		const api = makeClient(fetchMock);

		await api.setup.state();
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(init.body).toBe("{}");
	});

	it("routes calls to the correct wire-level route name", async () => {
		const fetchMock: FetchMock = vi.fn(async () =>
			jsonResponse({ data: { ok: true, progress: {} } }),
		);
		const api = makeClient(fetchMock);

		await api.progress.tick({
			stepType: "lesson",
			stepId: "lesson_1",
			positionSeconds: 30,
			percentComplete: 50,
		});
		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/_emdash/api/plugins/lms-core/progress:tick");

		fetchMock.mockClear();
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { items: [], hasMore: false } }));
		await api.curriculum.myLearning({ status: "active" });
		const [url2] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url2).toBe("/_emdash/api/plugins/lms-core/my-learning");

		fetchMock.mockClear();
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				data: {
					added: [],
					unknownEmails: [],
					alreadyMembers: [],
					counts: { added: 0, unknown: 0, alreadyMembers: 0 },
				},
			}),
		);
		await api.cohorts.import({ cohortId: "coh_1", emails: ["x@y.z"] });
		const [url3] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url3).toBe("/_emdash/api/plugins/lms-core/cohort:import");

		fetchMock.mockClear();
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ data: { totalStudents: 0, active30d: 0, avgCompletion: 0, quizPassRate: 0 } }),
		);
		await api.instructorAnalytics.dashboardStats();
		const [url4] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url4).toBe("/_emdash/api/plugins/lms-core/instructor:dashboard-stats");
	});

	it("serializes input payloads as JSON on the body", async () => {
		const fetchMock: FetchMock = vi.fn(async () =>
			jsonResponse({ data: { ok: true, enrollment: {} } }),
		);
		const api = makeClient(fetchMock);

		await api.enrollments.enroll({ courseId: "course_1", source: "free" });
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(init.body).toBe(JSON.stringify({ courseId: "course_1", source: "free" }));
	});

	it("throws MALFORMED_RESPONSE when a 2xx body is missing the `data` wrapper", async () => {
		const fetchMock: FetchMock = vi.fn(async () => jsonResponse({ unexpected: "shape" }));
		const api = makeClient(fetchMock);

		await expect(api.setup.state()).rejects.toMatchObject({
			code: "MALFORMED_RESPONSE",
			status: 200,
		});
	});

	it("uses a custom baseUrl when provided", async () => {
		const fetchMock: FetchMock = vi.fn(async () =>
			jsonResponse({ data: { items: [], hasMore: false } }),
		);
		const api = createApiClient({
			fetch: fetchMock as unknown as typeof fetch,
			baseUrl: "https://example.com/api/plugins/lms-core",
		});

		await api.catalog();
		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://example.com/api/plugins/lms-core/catalog");
	});
});

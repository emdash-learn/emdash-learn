import { describe, expect, it, vi } from "vitest";

import { createApiClient, LmsApiError } from "../../../src/admin/api-client.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});
}

function makeFetchMock() {
	return vi.fn<typeof fetch>();
}

function makeClient(fetchMock: typeof fetch) {
	return createApiClient({ fetch: fetchMock });
}

describe("createApiClient", () => {
	it("preserves the setup wizard contract", async () => {
		const fetchMock = makeFetchMock();
		fetchMock.mockResolvedValue(
			jsonResponse({ data: { state: { version: 1, completedSteps: [] }, targetVersion: 1 } }),
		);
		const api = makeClient(fetchMock);

		await expect(api.setup.state()).resolves.toEqual({
			state: { version: 1, completedSteps: [] },
			targetVersion: 1,
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/_emdash/api/plugins/lms-core/setup:state");
	});

	it("runs server-derived setup convergence without accepting client step claims", async () => {
		const fetchMock = makeFetchMock();
		const result = {
			state: {
				version: 4,
				completedSteps: ["collections:courses"],
				lastRunAt: "2026-07-26T12:00:00.000Z",
			},
			schemaWrites: 2,
			projection: { errors: 0 },
		};
		fetchMock.mockResolvedValue(jsonResponse({ data: result }));
		const api = makeClient(fetchMock);

		await expect(api.setup.run()).resolves.toEqual(result);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/_emdash/api/plugins/lms-core/setup:run");
		expect(fetchMock.mock.calls[0]?.[1]?.body).toBe("{}");
		expect(api.setup).not.toHaveProperty("mark");
	});

	it("maps the canonical Assessment draft lifecycle to exact route payloads", async () => {
		const fetchMock = makeFetchMock();
		const draft = {
			courseId: "course-1",
			title: "Safety check",
			passingScore: 70,
			questions: [
				{
					id: "question-1",
					type: "true_false" as const,
					prompt: "Inspect first?",
					points: 1,
					correctAnswer: true,
				},
			],
		};
		const api = makeClient(fetchMock);

		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { items: [] } }));
		await api.assessment.listDrafts();
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { checkId: "check-1", ...draft } }));
		await api.assessment.getDraft("check-1");
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { checkId: "check-1", ...draft } }));
		await api.assessment.createDraft(draft);
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { checkId: "check-1", ...draft } }));
		await api.assessment.updateDraft("check-1", draft);
		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { deleted: true } }));
		await api.assessment.deleteDraft("check-1");

		expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.body])).toEqual([
			["/_emdash/api/plugins/lms-core/assessment:draft-list", "{}"],
			["/_emdash/api/plugins/lms-core/assessment:draft-get", '{"checkId":"check-1"}'],
			["/_emdash/api/plugins/lms-core/assessment:draft-create", JSON.stringify(draft)],
			[
				"/_emdash/api/plugins/lms-core/assessment:draft-update",
				JSON.stringify({ checkId: "check-1", draft }),
			],
			["/_emdash/api/plugins/lms-core/assessment:draft-delete", '{"checkId":"check-1"}'],
		]);
	});

	it("maps publish and archive without treating publication as draft status", async () => {
		const fetchMock = makeFetchMock();
		const api = makeClient(fetchMock);

		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				data: {
					courseId: "course-1",
					checkId: "check-1",
					revisionId: "revision-2",
					title: "Safety check",
					passingScore: 70,
					questions: [],
				},
			}),
		);
		await expect(api.assessment.publish("check-1")).resolves.toMatchObject({
			checkId: "check-1",
			revisionId: "revision-2",
		});

		fetchMock.mockResolvedValueOnce(jsonResponse({ data: { archived: true } }));
		await expect(api.assessment.archive("check-1")).resolves.toEqual({ archived: true });

		expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.body])).toEqual([
			["/_emdash/api/plugins/lms-core/assessment:publish", '{"checkId":"check-1"}'],
			["/_emdash/api/plugins/lms-core/assessment:archive", '{"checkId":"check-1"}'],
		]);
	});

	it("loads published courses for the assessment course selector", async () => {
		const fetchMock = makeFetchMock();
		fetchMock.mockResolvedValue(
			jsonResponse({
				data: {
					items: [{ id: "course-1", title: "Safety", slug: "safety", publishedAt: null }],
					hasMore: false,
				},
			}),
		);
		const api = makeClient(fetchMock);

		await expect(api.courses.listPublished({ limit: 100 })).resolves.toMatchObject({
			items: [{ id: "course-1", title: "Safety" }],
			hasMore: false,
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/_emdash/api/plugins/lms-core/catalog");
		expect(fetchMock.mock.calls[0]?.[1]?.body).toBe('{"limit":100}');
	});

	it("queries engagement reporting with the exact range and optional Course filter", async () => {
		const fetchMock = makeFetchMock();
		fetchMock.mockResolvedValue(
			jsonResponse({
				data: {
					calculatedThrough: "2026-07-26T12:00:00.000Z",
					courses: [
						{
							courseId: "course-1",
							opens: { total: 8, anonymous: 5, verified: 3 },
							verifiedAccountDays: 2,
							lessonOpens: 7,
							lessonCompletions: 4,
							checkOpens: 3,
							checkSubmissions: 2,
							passedSubmissions: 1,
						},
					],
				},
			}),
		);
		const api = makeClient(fetchMock);

		await expect(
			api.reporting.query({
				from: "2026-07-20T00:00:00.000Z",
				to: "2026-07-27T00:00:00.000Z",
				courseId: "course-1",
			}),
		).resolves.toMatchObject({
			calculatedThrough: "2026-07-26T12:00:00.000Z",
			courses: [{ courseId: "course-1", verifiedAccountDays: 2 }],
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/_emdash/api/plugins/lms-core/reporting:query");
		expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
			'{"from":"2026-07-20T00:00:00.000Z","to":"2026-07-27T00:00:00.000Z","courseId":"course-1"}',
		);
	});

	it("sends the EmDash CSRF header and same-origin credentials", async () => {
		const fetchMock = makeFetchMock();
		fetchMock.mockResolvedValue(jsonResponse({ data: { items: [] } }));
		const api = makeClient(fetchMock);
		await api.assessment.listDrafts();

		const firstCall = fetchMock.mock.calls[0];
		expect(firstCall).toBeDefined();
		const init = firstCall?.[1];
		expect(init).toMatchObject({
			method: "POST",
			credentials: "same-origin",
			body: "{}",
		});
		expect(init.headers).toMatchObject({
			"Content-Type": "application/json",
			Accept: "application/json",
			"X-EmDash-Request": "1",
		});
	});

	it("surfaces plugin error envelopes as LmsApiError", async () => {
		const fetchMock = makeFetchMock();
		fetchMock.mockResolvedValue(
			jsonResponse(
				{ error: { code: "LEARN_ASSESSMENT_NOT_FOUND", message: "Not found" } },
				{ status: 404 },
			),
		);
		const api = makeClient(fetchMock);

		await expect(api.assessment.getDraft("missing")).rejects.toMatchObject({
			name: "LmsApiError",
			code: "LEARN_ASSESSMENT_NOT_FOUND",
			message: "Not found",
			status: 404,
		});
	});

	it("maps network and malformed responses to stable client errors", async () => {
		const rejected = makeFetchMock();
		rejected.mockRejectedValue(new TypeError("Failed to fetch"));
		await expect(makeClient(rejected).setup.state()).rejects.toEqual(
			expect.objectContaining<LmsApiError>({
				name: "LmsApiError",
				code: "NETWORK_ERROR",
				message: "Failed to fetch",
				status: 0,
			}),
		);

		const malformed = makeFetchMock();
		malformed.mockResolvedValue(jsonResponse({ unexpected: true }));
		await expect(makeClient(malformed).setup.state()).rejects.toMatchObject({
			code: "MALFORMED_RESPONSE",
			status: 200,
		});
	});
});

/**
 * Browser-side RPC client for the reduced EmDash Learn admin surface.
 *
 * Course and lesson authoring belongs to EmDash core's content editor. Learn's
 * own admin routes cover setup, knowledge-check authoring, and reporting.
 */

import { PLUGIN_ID } from "../constants.js";
import type {
	EngagementReport,
	EngagementReportQuery,
} from "../modules/engagement-reporting/index.js";
import type {
	DraftCheck,
	DraftCheckInput,
	PublishedCheckPresentation,
} from "../modules/assessment/index.js";
import type {
	PublishedCourseCatalogInput,
	PublishedCourseCatalogPage,
} from "../modules/published-courses.js";
import type { SetupOrchestratorResult } from "../setup/orchestrator.js";
import type { BootstrapState } from "../types/storage.js";

export type {
	ChoiceOption,
	DraftCheck,
	DraftCheckInput,
	DraftQuestion,
	MultipleChoiceQuestion,
	PublishedCheckPresentation,
	ShortTextQuestion,
	SingleChoiceQuestion,
	TrueFalseQuestion,
} from "../modules/assessment/index.js";

export class LmsApiError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "LmsApiError";
	}
}

export interface SetupStateResponse {
	state: BootstrapState;
	targetVersion: number;
}

export interface AssessmentDraftListResponse {
	items: DraftCheck[];
}

export interface AssessmentDraftDeleteResponse {
	deleted: true;
}

export interface AssessmentArchiveResponse {
	archived: boolean;
}

export type ReportingQueryInput = EngagementReportQuery;
export type ReportingQueryResponse = EngagementReport;

export interface CreateApiClientOptions {
	fetch?: typeof fetch;
	baseUrl?: string;
}

interface ApiSuccessEnvelope<T> {
	data: T;
}

interface ApiErrorEnvelope {
	error: { code: string; message: string };
}

function isApiError(body: unknown): body is ApiErrorEnvelope {
	if (typeof body !== "object" || body === null || !("error" in body)) return false;
	const error = body.error;
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string" &&
		"message" in error &&
		typeof error.message === "string"
	);
}

function isApiSuccess<T>(body: unknown): body is ApiSuccessEnvelope<T> {
	return typeof body === "object" && body !== null && "data" in body;
}

export function createApiClient(options: CreateApiClientOptions = {}) {
	const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
	const baseUrl = options.baseUrl ?? `/_emdash/api/plugins/${PLUGIN_ID}`;

	async function request<TOutput>(routeName: string, input?: unknown): Promise<TOutput> {
		let response: Response;
		try {
			response = await fetchImpl(`${baseUrl}/${routeName}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
					"X-EmDash-Request": "1",
				},
				credentials: "same-origin",
				body: JSON.stringify(input ?? {}),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new LmsApiError("NETWORK_ERROR", message, 0);
		}

		const text = await response.text();
		let body: unknown;
		try {
			body = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			throw new LmsApiError(
				"NETWORK_ERROR",
				"Server returned a non-JSON response.",
				response.status,
			);
		}

		if (!response.ok) {
			if (isApiError(body)) {
				throw new LmsApiError(body.error.code, body.error.message, response.status);
			}
			throw new LmsApiError(
				"MALFORMED_RESPONSE",
				`Request failed (${response.status}).`,
				response.status,
			);
		}

		if (!isApiSuccess<TOutput>(body)) {
			throw new LmsApiError(
				"MALFORMED_RESPONSE",
				"Response envelope is missing its data field.",
				response.status,
			);
		}
		return body.data;
	}

	return {
		setup: {
			state: () => request<SetupStateResponse>("setup:state"),
			run: () => request<SetupOrchestratorResult>("setup:run"),
			callRoute: (route: string, input?: unknown) => request<unknown>(route, input),
		},
		assessment: {
			listDrafts: () => request<AssessmentDraftListResponse>("assessment:draft-list"),
			getDraft: (checkId: string) => request<DraftCheck>("assessment:draft-get", { checkId }),
			createDraft: (draft: DraftCheckInput) =>
				request<DraftCheck>("assessment:draft-create", draft),
			updateDraft: (checkId: string, draft: DraftCheckInput) =>
				request<DraftCheck>("assessment:draft-update", { checkId, draft }),
			deleteDraft: (checkId: string) =>
				request<AssessmentDraftDeleteResponse>("assessment:draft-delete", { checkId }),
			publish: (checkId: string) =>
				request<PublishedCheckPresentation>("assessment:publish", { checkId }),
			archive: (checkId: string) =>
				request<AssessmentArchiveResponse>("assessment:archive", { checkId }),
		},
		courses: {
			listPublished: (input: PublishedCourseCatalogInput = {}) =>
				request<PublishedCourseCatalogPage>("catalog", input),
		},
		reporting: {
			query: (input: ReportingQueryInput) =>
				request<ReportingQueryResponse>("reporting:query", input),
		},
	};
}

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * Thin REST wrapper over emdash's `/_emdash/api/schema/*` endpoints. Used
 * ONLY from the admin browser so requests ride the admin session cookie
 * (per §4.2). Never import this from `src/engine/*` or route handlers.
 */

import type {
	CreateCollectionInput,
	CreateFieldInput,
	UpdateCollectionInput,
} from "emdash";

export interface RemoteField {
	id: string;
	collectionId: string;
	slug: string;
	label: string;
	type: string;
	required: boolean;
	unique: boolean;
	defaultValue: unknown;
	validation: Record<string, unknown> | null;
	widget: string | null;
	options: Record<string, unknown> | null;
	sortOrder: number;
	searchable: boolean;
	translatable: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface RemoteCollection {
	id: string;
	slug: string;
	label: string;
	labelSingular: string | null;
	description: string | null;
	icon: string | null;
	supports: string[];
	source: string | null;
	urlPattern: string | null;
	hasSeo: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface RemoteCollectionWithFields extends RemoteCollection {
	fields: RemoteField[];
}

export class CoreSchemaClientError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly body: unknown,
	) {
		super(message);
		this.name = "CoreSchemaClientError";
	}
}

interface ClientOptions {
	/** Base URL without trailing slash; defaults to same-origin. */
	baseUrl?: string;
	/** Overridable fetch — injected in tests. */
	fetcher?: typeof fetch;
}

/**
 * Returned from `getCollection` when the collection does not exist.
 */
export const NOT_FOUND = Symbol("NOT_FOUND");
export type Lookup<T> = T | typeof NOT_FOUND;

export function createCoreSchemaClient(opts: ClientOptions = {}): {
	listCollections(): Promise<RemoteCollection[]>;
	getCollection(slug: string): Promise<Lookup<RemoteCollectionWithFields>>;
	createCollection(input: CreateCollectionInput): Promise<RemoteCollection>;
	updateCollection(slug: string, patch: UpdateCollectionInput): Promise<RemoteCollection>;
	deleteCollection(slug: string, opts?: { force?: boolean }): Promise<void>;
	listFields(collectionSlug: string): Promise<RemoteField[]>;
	createField(collectionSlug: string, input: CreateFieldInput): Promise<RemoteField>;
} {
	const base = opts.baseUrl?.replace(/\/+$/, "") ?? "";
	const fetcher = opts.fetcher ?? fetch;

	async function request<T>(
		method: string,
		path: string,
		body?: unknown,
		allow404 = false,
	): Promise<T | typeof NOT_FOUND> {
		const url = `${base}/_emdash/api/schema${path}`;
		// CSRF is satisfied by either an Origin header (browsers send one) or a
		// custom `X-EmDash-Request: 1` header. Send the custom header so the
		// client works for non-browser test harnesses too.
		const headers: Record<string, string> = {
			Accept: "application/json",
			"X-EmDash-Request": "1",
		};
		if (body !== undefined) headers["Content-Type"] = "application/json";
		const init: RequestInit = { method, headers, credentials: "same-origin" };
		if (body !== undefined) init.body = JSON.stringify(body);

		const res = await fetcher(url, init);
		if (allow404 && res.status === 404) return NOT_FOUND;

		const text = await res.text();
		let parsed: unknown = null;
		if (text.length > 0) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
		}

		if (!res.ok) {
			throw new CoreSchemaClientError(
				`schema ${method} ${path} failed: ${res.status}`,
				res.status,
				parsed,
			);
		}
		// Emdash wraps success bodies in `{ data: T }` (see apiSuccess in core).
		const envelope = parsed as { data?: unknown } | null;
		const unwrapped = envelope && typeof envelope === "object" && "data" in envelope
			? envelope.data
			: parsed;
		return unwrapped as T;
	}

	return {
		async listCollections() {
			const body = (await request<{ items: RemoteCollection[] }>("GET", "/collections")) as {
				items: RemoteCollection[];
			};
			return body.items;
		},

		async getCollection(slug) {
			const result = await request<{ item: RemoteCollectionWithFields }>(
				"GET",
				`/collections/${encodeURIComponent(slug)}?includeFields=true`,
				undefined,
				true,
			);
			if (result === NOT_FOUND) return NOT_FOUND;
			return result.item;
		},

		async createCollection(input) {
			const body = (await request<{ item: RemoteCollection }>(
				"POST",
				"/collections",
				input,
			)) as { item: RemoteCollection };
			return body.item;
		},

		async updateCollection(slug, patch) {
			const body = (await request<{ item: RemoteCollection }>(
				"PUT",
				`/collections/${encodeURIComponent(slug)}`,
				patch,
			)) as { item: RemoteCollection };
			return body.item;
		},

		async deleteCollection(slug, { force = false } = {}) {
			const suffix = force ? "?force=true" : "";
			await request<unknown>("DELETE", `/collections/${encodeURIComponent(slug)}${suffix}`);
		},

		async listFields(collectionSlug) {
			const body = (await request<{ items: RemoteField[] }>(
				"GET",
				`/collections/${encodeURIComponent(collectionSlug)}/fields`,
			)) as { items: RemoteField[] };
			return body.items;
		},

		async createField(collectionSlug, input) {
			const body = (await request<{ item: RemoteField }>(
				"POST",
				`/collections/${encodeURIComponent(collectionSlug)}/fields`,
				input,
			)) as { item: RemoteField };
			return body.item;
		},
	};
}

export type CoreSchemaClient = ReturnType<typeof createCoreSchemaClient>;

/**
 * Thin REST wrapper over emdash's `/_emdash/api/schema/*` endpoints. Used
 * ONLY from the admin browser so requests ride the admin session cookie
 * (per §4.2). Never import this from `src/engine/*` or route handlers.
 */

import { z } from "astro/zod";
import type { CreateCollectionInput, CreateFieldInput, UpdateCollectionInput } from "emdash";

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
	updatedAt?: string;
}

export interface RemoteCollection {
	id: string;
	slug: string;
	label: string;
	labelSingular: string | null;
	description: string | null;
	icon: string | null;
	supports: NonNullable<CreateCollectionInput["supports"]>;
	source: string | null;
	urlPattern: string | null;
	hasSeo: boolean;
	commentsEnabled: boolean;
	commentsModeration: "all" | "first_time" | "none";
	commentsClosedAfterDays: number;
	commentsAutoApproveUsers: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface RemoteCollectionWithFields extends RemoteCollection {
	fields: RemoteField[];
}

const unknownRecordSchema = z.record(z.string(), z.unknown());
const remoteFieldSchema = z
	.object({
		id: z.string(),
		collectionId: z.string(),
		slug: z.string(),
		label: z.string(),
		type: z.string(),
		required: z.boolean(),
		unique: z.boolean(),
		defaultValue: z
			.unknown()
			.nullish()
			.transform((value) => value ?? null),
		validation: unknownRecordSchema.nullish().transform((value) => value ?? null),
		widget: z
			.string()
			.nullish()
			.transform((value) => value ?? null),
		options: unknownRecordSchema.nullish().transform((value) => value ?? null),
		sortOrder: z.number(),
		searchable: z.boolean(),
		translatable: z.boolean(),
		createdAt: z.string(),
		updatedAt: z.string().optional(),
	})
	.passthrough() satisfies z.ZodType<RemoteField>;

const remoteCollectionSchema = z
	.object({
		id: z.string(),
		slug: z.string(),
		label: z.string(),
		labelSingular: z
			.string()
			.nullish()
			.transform((value) => value ?? null),
		description: z
			.string()
			.nullish()
			.transform((value) => value ?? null),
		icon: z
			.string()
			.nullish()
			.transform((value) => value ?? null),
		supports: z.array(z.enum(["drafts", "revisions", "preview", "scheduling", "search", "seo"])),
		source: z
			.string()
			.nullish()
			.transform((value) => value ?? null),
		urlPattern: z
			.string()
			.nullish()
			.transform((value) => value ?? null),
		hasSeo: z.boolean(),
		commentsEnabled: z.boolean(),
		commentsModeration: z.enum(["all", "first_time", "none"]),
		commentsClosedAfterDays: z.number(),
		commentsAutoApproveUsers: z.boolean(),
		createdAt: z.string(),
		updatedAt: z.string(),
	})
	.passthrough() satisfies z.ZodType<RemoteCollection>;

const remoteCollectionWithFieldsSchema = remoteCollectionSchema.extend({
	fields: z.array(remoteFieldSchema),
}) satisfies z.ZodType<RemoteCollectionWithFields>;

const collectionListSchema = z.object({
	items: z.array(remoteCollectionSchema),
});
const collectionItemSchema = z.object({ item: remoteCollectionSchema });
const collectionWithFieldsItemSchema = z.object({
	item: remoteCollectionWithFieldsSchema,
});
const fieldListSchema = z.object({ items: z.array(remoteFieldSchema) });
const fieldItemSchema = z.object({ item: remoteFieldSchema });
const contentProbeSchema = z.object({ items: z.array(z.unknown()) });

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
	/** @deprecated Setup never deletes administrator-owned content collections. */
	deleteCollection(slug: string, opts?: { force?: boolean }): Promise<void>;
	isCollectionEmpty(collectionSlug: string): Promise<boolean>;
	listFields(collectionSlug: string): Promise<RemoteField[]>;
	createField(collectionSlug: string, input: CreateFieldInput): Promise<RemoteField>;
} {
	const base = opts.baseUrl?.replace(/\/+$/, "") ?? "";
	const fetcher = opts.fetcher ?? fetch;

	async function request<T>(
		method: string,
		path: string,
		schema: z.ZodType<T>,
		body?: unknown,
		allow404?: false,
		api?: string,
	): Promise<T>;
	async function request<T>(
		method: string,
		path: string,
		schema: z.ZodType<T>,
		body: unknown,
		allow404: true,
		api?: string,
	): Promise<T | typeof NOT_FOUND>;
	async function request<T>(
		method: string,
		path: string,
		schema: z.ZodType<T>,
		body?: unknown,
		allow404 = false,
		api = "schema",
	): Promise<T | typeof NOT_FOUND> {
		const url = `${base}/_emdash/api/${api}${path}`;
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
				`${api} ${method} ${path} failed: ${res.status}`,
				res.status,
				parsed,
			);
		}
		// Emdash wraps success bodies in `{ data: T }` (see apiSuccess in core).
		const unwrapped =
			typeof parsed === "object" && parsed !== null && Reflect.has(parsed, "data")
				? Reflect.get(parsed, "data")
				: parsed;
		const decoded = schema.safeParse(unwrapped);
		if (!decoded.success) {
			throw new CoreSchemaClientError(
				`${api} ${method} ${path} returned a malformed response`,
				502,
				parsed,
			);
		}
		return decoded.data;
	}

	return {
		async listCollections() {
			const body = await request("GET", "/collections", collectionListSchema);
			return body.items;
		},

		async getCollection(slug) {
			const result = await request(
				"GET",
				`/collections/${encodeURIComponent(slug)}?includeFields=true`,
				collectionWithFieldsItemSchema,
				undefined,
				true,
			);
			if (result === NOT_FOUND) return NOT_FOUND;
			return result.item;
		},

		async createCollection(input) {
			const body = await request("POST", "/collections", collectionItemSchema, input);
			return body.item;
		},

		async updateCollection(slug, patch) {
			const body = await request(
				"PUT",
				`/collections/${encodeURIComponent(slug)}`,
				collectionItemSchema,
				patch,
			);
			return body.item;
		},

		async deleteCollection() {
			throw new Error(
				"Setup cannot delete Course or Lesson collections; authored content remains administrator-owned.",
			);
		},

		async isCollectionEmpty(collectionSlug) {
			const slug = encodeURIComponent(collectionSlug);
			for (const path of [`/${slug}?limit=1`, `/${slug}/trash?limit=1`]) {
				// oxlint-disable-next-line no-await-in-loop -- both active and trashed content must be absent
				const result = await request("GET", path, contentProbeSchema, undefined, false, "content");
				if (typeof result !== "object" || result === null || !Array.isArray(result.items)) {
					throw new CoreSchemaClientError(
						`content GET ${path} returned a malformed response`,
						502,
						result,
					);
				}
				if (result.items.length > 0) return false;
			}
			return true;
		},

		async listFields(collectionSlug) {
			const body = await request(
				"GET",
				`/collections/${encodeURIComponent(collectionSlug)}/fields`,
				fieldListSchema,
			);
			return body.items;
		},

		async createField(collectionSlug, input) {
			const body = await request(
				"POST",
				`/collections/${encodeURIComponent(collectionSlug)}/fields`,
				fieldItemSchema,
				input,
			);
			return body.item;
		},
	};
}

export type CoreSchemaClient = ReturnType<typeof createCoreSchemaClient>;

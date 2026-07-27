import { describe, expect, it, vi } from "vitest";

import {
	CoreSchemaClientError,
	createCoreSchemaClient,
} from "../../../src/setup/core-schema-client.js";

describe("core schema browser client", () => {
	it("decodes the collection-with-fields shape returned by EmDash", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				success: true,
				data: {
					item: {
						id: "collection-1",
						slug: "courses",
						label: "Courses",
						supports: ["drafts", "revisions"],
						hasSeo: false,
						commentsEnabled: false,
						commentsModeration: "first_time",
						commentsClosedAfterDays: 90,
						commentsAutoApproveUsers: true,
						createdAt: "2026-07-26T00:00:00.000Z",
						updatedAt: "2026-07-26T00:00:00.000Z",
						fields: [
							{
								id: "field-1",
								collectionId: "collection-1",
								slug: "title",
								label: "Title",
								type: "string",
								columnType: "TEXT",
								required: true,
								unique: false,
								sortOrder: 0,
								searchable: false,
								translatable: true,
								createdAt: "2026-07-26T00:00:00.000Z",
							},
						],
					},
				},
			}),
		);
		const client = createCoreSchemaClient({ fetcher });

		await expect(client.getCollection("courses")).resolves.toMatchObject({
			slug: "courses",
			labelSingular: null,
			description: null,
			icon: null,
			source: null,
			urlPattern: null,
			fields: [
				{
					slug: "title",
					defaultValue: null,
					validation: null,
					widget: null,
					options: null,
				},
			],
		});
	});

	it("rejects a successful response that does not satisfy the schema contract", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
			Response.json({
				data: {
					items: [{ id: "collection-1", slug: "courses" }],
				},
			}),
		);
		const client = createCoreSchemaClient({ fetcher });

		await expect(client.listCollections()).rejects.toEqual(
			expect.objectContaining<CoreSchemaClientError>({
				name: "CoreSchemaClientError",
				status: 502,
				message: "schema GET /collections returned a malformed response",
			}),
		);
	});
});

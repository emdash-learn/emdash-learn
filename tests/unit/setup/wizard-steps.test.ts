import { describe, expect, it, vi } from "vitest";

import {
	createCoreSchemaClient,
	NOT_FOUND,
	type RemoteCollectionWithFields,
} from "../../../src/setup/core-schema-client.js";
import { convergeSetup } from "../../../src/setup/orchestrator.js";
import { WIZARD_STEPS } from "../../../src/setup/steps.js";

interface SchemaHarness {
	schema: ReturnType<typeof createCoreSchemaClient>;
	writeCount(): number;
	requests(): string[];
}

interface SchemaHarnessOptions {
	content?: Record<string, { active?: number; trashed?: number }>;
	failContentProbeFor?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createSchemaHarness(
	initialCollections: RemoteCollectionWithFields[] = [],
	options: SchemaHarnessOptions = {},
): SchemaHarness {
	const collections = new Map(
		initialCollections.map((collection) => [collection.slug, structuredClone(collection)]),
	);
	let writes = 0;
	const requests: string[] = [];

	const fetcher: typeof fetch = async (input, init) => {
		const url = new URL(typeof input === "string" ? input : input.url);
		const method = init?.method ?? "GET";
		requests.push(`${method} ${url.pathname}${url.search}`);
		const schemaPath = url.pathname.replace("/_emdash/api/schema", "");
		const parsedBody: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
		const body = isRecord(parsedBody) ? parsedBody : {};

		const contentMatch = /^\/_emdash\/api\/content\/([^/]+)(\/trash)?$/.exec(url.pathname);
		if (method === "GET" && contentMatch) {
			const slug = decodeURIComponent(contentMatch[1]);
			if (options.failContentProbeFor === slug) {
				return Response.json({ error: { message: "Unavailable" } }, { status: 503 });
			}
			const kind = contentMatch[2] ? "trashed" : "active";
			const count = options.content?.[slug]?.[kind] ?? 0;
			return Response.json({
				data: {
					items: count > 0 ? [{ id: `${slug}:${kind}:1` }] : [],
					total: count,
				},
			});
		}

		const collectionMatch = /^\/collections\/([^/]+)$/.exec(schemaPath);
		if (method === "GET" && collectionMatch) {
			const collection = collections.get(decodeURIComponent(collectionMatch[1]));
			if (!collection) {
				return Response.json({ error: { message: "Not found" } }, { status: 404 });
			}
			return Response.json({ data: { item: structuredClone(collection) } });
		}

		if (method === "POST" && schemaPath === "/collections") {
			const slug = String(body.slug);
			const collection: RemoteCollectionWithFields = {
				id: `collection:${slug}`,
				slug,
				label: typeof body.label === "string" ? body.label : slug,
				labelSingular: typeof body.labelSingular === "string" ? body.labelSingular : null,
				description: typeof body.description === "string" ? body.description : null,
				icon: typeof body.icon === "string" ? body.icon : null,
				supports: Array.isArray(body.supports)
					? body.supports.filter((value): value is string => typeof value === "string")
					: [],
				source: typeof body.source === "string" ? body.source : null,
				urlPattern: typeof body.urlPattern === "string" ? body.urlPattern : null,
				hasSeo: typeof body.hasSeo === "boolean" ? body.hasSeo : false,
				commentsEnabled: false,
				commentsModeration: "first_time",
				commentsClosedAfterDays: 90,
				commentsAutoApproveUsers: true,
				createdAt: "2026-07-26T00:00:00.000Z",
				updatedAt: "2026-07-26T00:00:00.000Z",
				fields: [],
			};
			collections.set(slug, collection);
			writes += 1;
			return Response.json({ data: { item: structuredClone(collection) } }, { status: 201 });
		}

		if (method === "PUT" && collectionMatch) {
			const slug = decodeURIComponent(collectionMatch[1]);
			const collection = collections.get(slug);
			if (!collection) {
				return Response.json({ error: { message: "Not found" } }, { status: 404 });
			}
			Object.assign(collection, body);
			writes += 1;
			return Response.json({ data: { item: structuredClone(collection) } });
		}

		const fieldMatch = /^\/collections\/([^/]+)\/fields$/.exec(schemaPath);
		if (method === "POST" && fieldMatch) {
			const slug = decodeURIComponent(fieldMatch[1]);
			const collection = collections.get(slug);
			if (!collection) {
				return Response.json({ error: { message: "Not found" } }, { status: 404 });
			}
			const fieldSlug = String(body.slug);
			const field: RemoteCollectionWithFields["fields"][number] = {
				id: `field:${slug}:${fieldSlug}`,
				collectionId: collection.id,
				slug: fieldSlug,
				label: typeof body.label === "string" ? body.label : fieldSlug,
				type: typeof body.type === "string" ? body.type : "string",
				required: typeof body.required === "boolean" ? body.required : false,
				unique: typeof body.unique === "boolean" ? body.unique : false,
				defaultValue: body.defaultValue ?? null,
				validation: isRecord(body.validation) ? body.validation : null,
				widget: typeof body.widget === "string" ? body.widget : null,
				options: isRecord(body.options) ? body.options : null,
				sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : collection.fields.length,
				searchable: typeof body.searchable === "boolean" ? body.searchable : false,
				translatable: typeof body.translatable === "boolean" ? body.translatable : true,
				createdAt: "2026-07-26T00:00:00.000Z",
				updatedAt: "2026-07-26T00:00:00.000Z",
			};
			collection.fields.push(field);
			writes += 1;
			return Response.json({ data: { item: structuredClone(field) } }, { status: 201 });
		}

		return Response.json(
			{ error: { message: `Unhandled ${method} ${schemaPath}` } },
			{ status: 500 },
		);
	};

	return {
		schema: createCoreSchemaClient({ baseUrl: "https://cms.example", fetcher }),
		writeCount: () => writes,
		requests: () => [...requests],
	};
}

function existingCollection(
	slug: string,
	fields: Array<{
		slug: string;
		label: string;
		type: string;
		required?: boolean;
		unique?: boolean;
		defaultValue?: unknown;
		validation?: Record<string, unknown> | null;
		widget?: string | null;
		options?: Record<string, unknown> | null;
		searchable?: boolean;
		translatable?: boolean;
	}>,
): RemoteCollectionWithFields {
	return {
		id: `collection:${slug}`,
		slug,
		label: slug === "courses" ? "Courses" : "Lessons",
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
		fields: fields.map((field, sortOrder) => ({
			id: `field:${slug}:${field.slug}`,
			collectionId: `collection:${slug}`,
			slug: field.slug,
			label: field.label,
			type: field.type,
			required: field.required ?? false,
			unique: field.unique ?? false,
			defaultValue: field.defaultValue ?? null,
			validation: field.validation ?? null,
			widget: field.widget ?? null,
			options: field.options ?? null,
			sortOrder,
			searchable: field.searchable ?? false,
			translatable: field.translatable ?? true,
			createdAt: "2026-07-26T00:00:00.000Z",
			updatedAt: "2026-07-26T00:00:00.000Z",
		})),
	};
}

describe("setup wizard schema contract", () => {
	it("persists completion derived from verified schema and a successful projection repair", async () => {
		const harness = createSchemaHarness();
		const persistState = vi.fn(async () => undefined);
		const repairProjection = vi.fn(async () => ({
			lessonsUpserted: 0,
			staleRowsDeleted: 0,
			errors: 0,
		}));

		const untrustedRequest = {
			schema: harness.schema,
			repairProjection,
			persistState,
			now: () => new Date("2026-07-26T12:00:00.000Z"),
			completedSteps: ["forged:complete"],
		};
		const result = await convergeSetup(untrustedRequest);

		expect(result.state).toEqual({
			version: 4,
			completedSteps: [
				"collection:courses",
				"fields:courses",
				"collection:lessons",
				"fields:lessons",
			],
			lastRunAt: "2026-07-26T12:00:00.000Z",
			verification: {
				contractVersion: 4,
				schema: "compatible",
				projection: "repaired",
			},
		});
		expect(result.schemaWrites).toBeGreaterThan(0);
		expect(repairProjection).toHaveBeenCalledOnce();
		expect(persistState).toHaveBeenCalledWith(result.state);
	});

	it("does not persist completion when projection repair reports an error", async () => {
		const harness = createSchemaHarness();
		const persistState = vi.fn(async () => undefined);

		await expect(
			convergeSetup({
				schema: harness.schema,
				repairProjection: async () => ({
					lessonsUpserted: 0,
					staleRowsDeleted: 0,
					errors: 1,
				}),
				persistState,
			}),
		).rejects.toMatchObject({
			name: "SetupVerificationError",
			stepId: "projection",
		});
		expect(persistState).not.toHaveBeenCalled();
	});

	it("does not expose collection deletion through setup orchestration", async () => {
		const harness = createSchemaHarness([existingCollection("courses", [])]);

		await expect(harness.schema.deleteCollection("courses", { force: true })).rejects.toThrow(
			/authored content remains administrator-owned/i,
		);
		expect(harness.requests()).not.toContain("DELETE /_emdash/api/schema/collections/courses");
	});

	it("repairs required collection settings without removing compatible supports", async () => {
		const courses = existingCollection("courses", []);
		courses.supports = ["preview"];
		const harness = createSchemaHarness([courses]);
		const collectionStep = WIZARD_STEPS.find((step) => step.id === "collection:courses");
		if (!collectionStep) throw new Error("courses collection step is missing");

		const before = await collectionStep.probe({ schema: harness.schema });
		expect(before).toMatchObject({
			status: "needs-apply",
			summary: "`courses` collection settings need repair.",
		});

		const result = await collectionStep.apply({ schema: harness.schema });
		expect(result.writes).toBe(1);

		const repaired = await harness.schema.getCollection("courses");
		expect(repaired).not.toBe(NOT_FOUND);
		if (repaired === NOT_FOUND) throw new Error("courses collection disappeared");
		expect(new Set(repaired.supports)).toEqual(
			new Set(["preview", "drafts", "revisions", "scheduling", "search"]),
		);
		expect(repaired.urlPattern).toBe("/courses/{slug}");
		expect(repaired.hasSeo).toBe(true);
	});

	it("preserves administrator-owned collection comment settings", async () => {
		const lessons = existingCollection("lessons", []);
		lessons.supports = ["drafts", "revisions", "scheduling", "search"];
		lessons.urlPattern = "/lessons/{slug}";
		lessons.hasSeo = true;
		lessons.commentsEnabled = false;
		lessons.commentsModeration = "none";
		const harness = createSchemaHarness([lessons]);
		const collectionStep = WIZARD_STEPS.find((step) => step.id === "collection:lessons");
		if (!collectionStep) throw new Error("lessons collection step is missing");

		const before = await collectionStep.probe({ schema: harness.schema });
		expect(before.status).toBe("ok");

		const result = await collectionStep.apply({ schema: harness.schema });
		expect(result.writes).toBe(0);

		const repaired = await harness.schema.getCollection("lessons");
		expect(repaired).not.toBe(NOT_FOUND);
		if (repaired === NOT_FOUND) throw new Error("lessons collection disappeared");
		expect(repaired.commentsEnabled).toBe(false);
		expect(repaired.commentsModeration).toBe("none");
	});

	it("provisions the complete Course → Lesson schema from an empty CMS", async () => {
		const harness = createSchemaHarness();

		expect(WIZARD_STEPS.map((step) => step.id)).toEqual([
			"collection:courses",
			"fields:courses",
			"collection:lessons",
			"fields:lessons",
		]);

		// oxlint-disable no-await-in-loop -- wizard steps depend on prior schema writes
		for (const step of WIZARD_STEPS) {
			const before = await step.probe({ schema: harness.schema });
			expect(before.status).toBe("needs-apply");

			const result = await step.apply({ schema: harness.schema });
			expect(result.writes).toBeGreaterThan(0);

			const after = await step.probe({ schema: harness.schema });
			expect(after.status).toBe("ok");
		}
		// oxlint-enable no-await-in-loop

		const courses = await harness.schema.getCollection("courses");
		const lessons = await harness.schema.getCollection("lessons");
		expect(courses).not.toBe(NOT_FOUND);
		expect(lessons).not.toBe(NOT_FOUND);
		if (courses === NOT_FOUND || lessons === NOT_FOUND) {
			throw new Error("wizard did not provision both collections");
		}

		expect(courses.fields.map((field) => field.slug)).toEqual([
			"title",
			"subtitle",
			"description",
			"body",
			"cover_image",
			"difficulty",
			"estimated_hours",
		]);
		expect(lessons.fields.map((field) => field.slug)).toEqual([
			"title",
			"course",
			"order",
			"summary",
			"body",
			"video_url",
			"duration_seconds",
		]);
		expect(harness.writeCount()).toBeGreaterThan(0);
	});

	it("performs zero writes when the completed schema is run again", async () => {
		const harness = createSchemaHarness();
		// oxlint-disable no-await-in-loop -- wizard steps depend on prior schema writes
		for (const step of WIZARD_STEPS) {
			await step.apply({ schema: harness.schema });
		}
		const writesAfterFirstRun = harness.writeCount();

		for (const step of WIZARD_STEPS) {
			const before = await step.probe({ schema: harness.schema });
			expect(before.status).toBe("ok");

			const result = await step.apply({ schema: harness.schema });
			expect(result.writes).toBe(0);
		}
		// oxlint-enable no-await-in-loop

		expect(harness.writeCount()).toBe(writesAfterFirstRun);
	});

	it("refuses to retype an existing locked field", async () => {
		const harness = createSchemaHarness([
			existingCollection("courses", [{ slug: "title", label: "Title", type: "number" }]),
		]);
		const fieldsStep = WIZARD_STEPS.find((step) => step.id === "fields:courses");
		if (!fieldsStep) throw new Error("courses fields step is missing");

		const probe = await fieldsStep.probe({ schema: harness.schema });
		expect(probe).toMatchObject({
			status: "conflict",
			summary: "Field type conflict detected; repair required.",
		});
		expect(probe.details).toContain("`title` must be `string`; found `number`.");

		await expect(fieldsStep.apply({ schema: harness.schema })).rejects.toThrow(
			/field type conflict.*refusing to apply/i,
		);
		expect(harness.writeCount()).toBe(0);
	});

	it("rejects a same-type field whose required semantics are incompatible", async () => {
		const harness = createSchemaHarness([
			existingCollection("courses", [{ slug: "title", label: "Title", type: "string" }]),
		]);
		const fieldsStep = WIZARD_STEPS.find((step) => step.id === "fields:courses");
		if (!fieldsStep) throw new Error("courses fields step is missing");

		const probe = await fieldsStep.probe({ schema: harness.schema });
		expect(probe).toMatchObject({
			status: "conflict",
			summary: "Field semantics conflict detected; repair required.",
		});
		expect(probe.details).toContain("`title.required` must be `true`; found `false`.");

		await expect(fieldsStep.apply({ schema: harness.schema })).rejects.toThrow(
			/field semantics conflict.*refusing to apply/i,
		);
		expect(harness.writeCount()).toBe(0);
	});

	it("rejects a known field whose validation contract differs", async () => {
		const harness = createSchemaHarness([
			existingCollection("courses", [
				{
					slug: "title",
					label: "Title",
					type: "string",
					required: true,
					validation: { maxLength: 201 },
				},
			]),
		]);
		const fieldsStep = WIZARD_STEPS.find((step) => step.id === "fields:courses");
		if (!fieldsStep) throw new Error("courses fields step is missing");

		const probe = await fieldsStep.probe({ schema: harness.schema });
		expect(probe).toMatchObject({
			status: "conflict",
			summary: "Field semantics conflict detected; repair required.",
		});
		expect(probe.details).toContain(
			'`title.validation` must be `{"maxLength":200}`; found `{"maxLength":201}`.',
		);
		expect(harness.writeCount()).toBe(0);
	});

	it("rejects a known field whose default differs", async () => {
		const harness = createSchemaHarness([
			existingCollection("lessons", [
				{
					slug: "order",
					label: "Order",
					type: "integer",
					required: true,
					defaultValue: 1,
					validation: { min: 0 },
				},
			]),
		]);
		const fieldsStep = WIZARD_STEPS.find((step) => step.id === "fields:lessons");
		if (!fieldsStep) throw new Error("lessons fields step is missing");

		const probe = await fieldsStep.probe({ schema: harness.schema });
		expect(probe).toMatchObject({
			status: "conflict",
			summary: "Field semantics conflict detected; repair required.",
		});
		expect(probe.details).toContain("`order.defaultValue` must be `0`; found `1`.");
		expect(harness.writeCount()).toBe(0);
	});

	it("rejects a known field whose uniqueness semantics differ", async () => {
		const harness = createSchemaHarness([
			existingCollection("courses", [
				{
					slug: "title",
					label: "Title",
					type: "string",
					required: true,
					unique: true,
					validation: { maxLength: 200 },
				},
			]),
		]);
		const fieldsStep = WIZARD_STEPS.find((step) => step.id === "fields:courses");
		if (!fieldsStep) throw new Error("courses fields step is missing");

		const probe = await fieldsStep.probe({ schema: harness.schema });
		expect(probe.status).toBe("conflict");
		expect(probe.details).toContain("`title.unique` must be `false`; found `true`.");
		expect(harness.writeCount()).toBe(0);
	});

	it("rejects a known field whose widget semantics differ", async () => {
		const harness = createSchemaHarness([
			existingCollection("courses", [
				{
					slug: "description",
					label: "Description",
					type: "text",
					validation: { maxLength: 1000 },
				},
			]),
		]);
		const fieldsStep = WIZARD_STEPS.find((step) => step.id === "fields:courses");
		if (!fieldsStep) throw new Error("courses fields step is missing");

		const probe = await fieldsStep.probe({ schema: harness.schema });
		expect(probe.status).toBe("conflict");
		expect(probe.details).toContain('`description.widget` must be `"textarea"`; found `null`.');
		expect(harness.writeCount()).toBe(0);
	});

	it("rejects a known field whose search semantics differ", async () => {
		const harness = createSchemaHarness([
			existingCollection("courses", [
				{
					slug: "title",
					label: "Title",
					type: "string",
					required: true,
					validation: { maxLength: 200 },
					searchable: true,
				},
			]),
		]);
		const fieldsStep = WIZARD_STEPS.find((step) => step.id === "fields:courses");
		if (!fieldsStep) throw new Error("courses fields step is missing");

		const probe = await fieldsStep.probe({ schema: harness.schema });
		expect(probe.status).toBe("conflict");
		expect(probe.details).toContain("`title.searchable` must be `false`; found `true`.");
		expect(harness.writeCount()).toBe(0);
	});

	it("rejects a known field whose translation semantics differ", async () => {
		const harness = createSchemaHarness([
			existingCollection("courses", [
				{
					slug: "title",
					label: "Title",
					type: "string",
					required: true,
					validation: { maxLength: 200 },
					translatable: false,
				},
			]),
		]);
		const fieldsStep = WIZARD_STEPS.find((step) => step.id === "fields:courses");
		if (!fieldsStep) throw new Error("courses fields step is missing");

		const probe = await fieldsStep.probe({ schema: harness.schema });
		expect(probe.status).toBe("conflict");
		expect(probe.details).toContain("`title.translatable` must be `true`; found `false`.");
		expect(harness.writeCount()).toBe(0);
	});

	it("rejects a reference field that targets another collection", async () => {
		const harness = createSchemaHarness([
			existingCollection("lessons", [
				{
					slug: "course",
					label: "Course",
					type: "reference",
					required: true,
					options: { collection: "posts", allowMultiple: false },
				},
			]),
		]);
		const fieldsStep = WIZARD_STEPS.find((step) => step.id === "fields:lessons");
		if (!fieldsStep) throw new Error("lessons fields step is missing");

		const probe = await fieldsStep.probe({ schema: harness.schema });
		expect(probe).toMatchObject({
			status: "conflict",
			summary: "Field semantics conflict detected; repair required.",
		});
		expect(probe.details).toContain(
			'`course.options` must be `{"allowMultiple":false,"collection":"courses"}`; found `{"allowMultiple":false,"collection":"posts"}`.',
		);
		expect(harness.writeCount()).toBe(0);
	});

	it("preserves an unknown field while adding the missing required schema", async () => {
		const harness = createSchemaHarness([
			existingCollection("courses", [{ slug: "name", label: "Title", type: "string" }]),
		]);
		const fieldsStep = WIZARD_STEPS.find((step) => step.id === "fields:courses");
		if (!fieldsStep) throw new Error("courses fields step is missing");

		const probe = await fieldsStep.probe({ schema: harness.schema });
		expect(probe).toMatchObject({
			status: "needs-apply",
			summary: "7 missing fields.",
		});

		const result = await fieldsStep.apply({ schema: harness.schema });
		expect(result.writes).toBe(7);

		const courses = await harness.schema.getCollection("courses");
		expect(courses).not.toBe(NOT_FOUND);
		if (courses === NOT_FOUND) throw new Error("courses collection disappeared");
		expect(courses.fields.map((field) => field.slug)).toEqual([
			"name",
			"title",
			"subtitle",
			"description",
			"body",
			"cover_image",
			"difficulty",
			"estimated_hours",
		]);
	});

	it("refuses to add a missing required field when the collection is not empty", async () => {
		const harness = createSchemaHarness([existingCollection("courses", [])], {
			content: { courses: { trashed: 1 } },
		});
		const fieldsStep = WIZARD_STEPS.find((step) => step.id === "fields:courses");
		if (!fieldsStep) throw new Error("courses fields step is missing");

		const probe = await fieldsStep.probe({ schema: harness.schema });
		expect(probe).toMatchObject({
			status: "conflict",
			summary: "Required fields cannot be added to a non-empty collection.",
		});
		expect(probe.details).toContain("`title` is required and missing.");

		await expect(fieldsStep.apply({ schema: harness.schema })).rejects.toThrow(
			/required fields.*non-empty collection/i,
		);
		expect(harness.writeCount()).toBe(0);
	});

	it("fails closed when collection emptiness cannot be proven", async () => {
		const harness = createSchemaHarness([existingCollection("courses", [])], {
			failContentProbeFor: "courses",
		});
		const fieldsStep = WIZARD_STEPS.find((step) => step.id === "fields:courses");
		if (!fieldsStep) throw new Error("courses fields step is missing");

		const probe = await fieldsStep.probe({ schema: harness.schema });
		expect(probe).toMatchObject({
			status: "error",
			summary: "Could not prove that `courses` is empty.",
		});

		await expect(fieldsStep.apply({ schema: harness.schema })).rejects.toThrow(
			/content GET.*failed: 503/i,
		);
		expect(harness.writeCount()).toBe(0);
	});
});

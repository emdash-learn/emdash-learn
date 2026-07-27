import { describe, expect, it } from "vitest";

import { DIGEST_SECRET_KEY } from "../../../src/kv-keys.js";
import { createLearnRuntimeServices } from "../../../src/runtime/services.js";
import { createMemoryStorageCollection } from "../../utils/memory-storage.js";
import { createRouteContext } from "../../utils/route-context.js";

describe("Learn runtime services", () => {
	it("isolates process-local public rate limits between plugin installations", async () => {
		const services = createLearnRuntimeServices({
			now: () => new Date("2026-07-26T12:00:00.000Z"),
			nextUuid: () => "00000000-0000-4000-8000-000000000001",
		});
		const firstInstallation = createRouteContext(
			{},
			{
				kvValues: {
					[DIGEST_SECRET_KEY]: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				},
			},
		);
		const secondInstallation = createRouteContext(
			{},
			{
				kvValues: {
					[DIGEST_SECRET_KEY]: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
				},
			},
		);

		for (let request = 0; request < 120; request += 1) {
			// oxlint-disable-next-line no-await-in-loop -- fill one fixed-window bucket
			await services.beforePublicAssessment(firstInstallation);
		}
		await expect(services.beforePublicAssessment(firstInstallation)).rejects.toMatchObject({
			code: "LEARN_RATE_LIMITED",
		});
		await expect(services.beforePublicAssessment(secondInstallation)).resolves.toBeUndefined();
	});

	it("requires the authored course to remain published before Assessment access", async () => {
		const courseIndex = createMemoryStorageCollection();
		const ctx = createRouteContext({}, { storage: { course_content_index: courseIndex } });
		let status: "draft" | "published" = "published";
		ctx.content = {
			async get(collection, id) {
				if (collection !== "courses" || id !== "course-typescript") return null;
				return {
					id,
					type: "courses",
					slug: "typescript",
					status,
					locale: "en",
					data: { title: "TypeScript" },
					createdAt: "2026-07-26T10:00:00.000Z",
					updatedAt: "2026-07-26T10:00:00.000Z",
					publishedAt: status === "published" ? "2026-07-26T10:00:00.000Z" : null,
				};
			},
			async list() {
				return { items: [], hasMore: false };
			},
		};
		const services = createLearnRuntimeServices();

		await expect(
			services.requirePublishedAssessmentCourse(ctx, "course-typescript"),
		).resolves.toBeUndefined();
		status = "draft";
		await expect(
			services.requirePublishedAssessmentCourse(ctx, "course-typescript"),
		).rejects.toMatchObject({ code: "LEARN_CONTENT_NOT_FOUND", status: 404 });
	});
});

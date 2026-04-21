/**
 * Integration tests for the `plugin:uninstall` lifecycle hook (AUDIT C4 / H8).
 *
 * Acceptance criteria:
 *   1. `plugin:uninstall({ deleteData: true })` with a non-empty courses
 *      collection → throws an Error directing the admin to the wizard
 *      "Drop plugin data" action.
 *   2. `plugin:uninstall({ deleteData: false })` → returns cleanly regardless
 *      of collection state.
 *   3. `plugin:uninstall({ deleteData: true })` with empty collections (no
 *      content) → returns cleanly.
 *
 * The hook accesses `ctx.content.list` to determine whether collections have
 * data. We seed a published course item via `seedCourse` + `handleContentPublish`
 * from the real emdash runtime to populate the collection.
 *
 * Note: emdash core dropping plugin storage rows on uninstall is NOT tested
 * here — that is an emdash platform test. We only assert the plugin hook's
 * behaviour per its specification.
 */

import { afterEach, describe, expect, it } from "vitest";
import { handleContentPublish } from "emdash";

import { createPlugin } from "../../../src/sandbox-entry.js";
import { seedCourse } from "../../utils/seed.js";
import { createTestPluginCtx, getTestDb } from "../../utils/test-plugin-ctx.js";

type TestCtx = Awaited<ReturnType<typeof createTestPluginCtx>>;

const contexts: TestCtx[] = [];

async function newCtx(opts: Parameters<typeof createTestPluginCtx>[0] = {}): Promise<TestCtx> {
	const ctx = await createTestPluginCtx(opts);
	contexts.push(ctx);
	return ctx;
}

afterEach(async () => {
	const pending = contexts.splice(0, contexts.length);
	await Promise.all(pending.map((ctx) => ctx.teardown()));
});

/**
 * Invoke the `plugin:uninstall` hook directly on the resolved plugin, passing
 * the test ctx. This bypasses emdash's plugin manager (which would also drop
 * storage, etc.) — we only test the hook's own logic.
 */
async function runUninstallHook(
	fixture: TestCtx,
	deleteData: boolean,
): Promise<void> {
	const resolved = createPlugin();
	const hookConfig = resolved.hooks["plugin:uninstall"];
	if (!hookConfig) throw new Error("plugin:uninstall hook is not registered");
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	await hookConfig.handler({ deleteData } as any, fixture.ctx);
}

describe("plugin:uninstall (AUDIT C4 / H8)", () => {
	it("deleteData=false → returns cleanly even with course data present", async () => {
		const fixture = await newCtx();
		const course = await seedCourse(fixture.ctx, { title: "Keep Course" });
		await handleContentPublish(getTestDb(fixture.ctx), "courses", course.id);

		// Should NOT throw.
		await expect(runUninstallHook(fixture, false)).resolves.toBeUndefined();
	});

	it("deleteData=true with non-empty courses collection → throws, message references wizard", async () => {
		const fixture = await newCtx();
		const course = await seedCourse(fixture.ctx, { title: "Delete Me" });
		await handleContentPublish(getTestDb(fixture.ctx), "courses", course.id);

		await expect(runUninstallHook(fixture, true)).rejects.toMatchObject({
			message: expect.stringContaining("/_emdash/admin/plugins/lms-core/setup"),
		});
	});

	it("deleteData=true with non-empty courses collection → error mentions Drop plugin data", async () => {
		const fixture = await newCtx();
		const course = await seedCourse(fixture.ctx, { title: "Another Course" });
		await handleContentPublish(getTestDb(fixture.ctx), "courses", course.id);

		const err = await runUninstallHook(fixture, true).catch((e) => e as Error);
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toContain("Drop plugin data");
	});

	it("deleteData=true with empty collections (no published content) → returns cleanly", async () => {
		// newCtx provisions the collections but seeds no content items.
		const fixture = await newCtx();

		// Should NOT throw — empty collections are fine.
		await expect(runUninstallHook(fixture, true)).resolves.toBeUndefined();
	});
});

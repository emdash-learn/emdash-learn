/**
 * Integration test fixture: boots a real emdash runtime against an in-memory
 * SQLite database, installs the Emdash Learn plugin, and exposes a
 * `PluginContext` that tests can hand straight to engine functions.
 *
 * Why not mocks? emdash's CLAUDE.md mandates real DB tests via
 * `better-sqlite3` — mocked-DB tests routinely miss storage/index/authz bugs
 * that matter in production. This fixture stays faithful to that rule:
 *
 *   - Boots the real emdash migrations (`runMigrations` from `emdash/db`).
 *   - Uses `SchemaRegistry` directly to provision the `courses` and
 *     `lessons` content collections. The T01 setup wizard normally runs
 *     these calls via REST from the admin browser session; tests bypass the
 *     HTTP layer and feed the same frozen fixtures (§18.3, §19.20) to the
 *     registry in-process.
 *   - Drives the install hook through `HookPipeline` directly rather than
 *     `PluginManager`. Reason: the manager's `install/activate` path filters
 *     the pipeline down to `active`-state plugins before running lifecycle
 *     hooks, so the initial `plugin:install` handler never sees a ctx (the
 *     upstream test `tests/unit/plugins/manager.test.ts` acknowledges this
 *     with the comment "hook would be called in real usage"). Hook pipeline
 *     registration is unconditional, so constructing a pipeline with the
 *     plugin already in it is the clean bypass — and it matches what the
 *     Astro runtime does at request time.
 *   - Captures the real `PluginContext` handed to `plugin:install`, then
 *     wraps `email`, `http`, and `log` with deterministic test spies per
 *     §18.9 (no real network, no real email, silent log).
 *
 * Each call returns an isolated DB and an isolated `outbox` array. Vitest
 * runs test files in parallel safely — no shared global state.
 */

import DatabaseConstructor, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { runMigrations } from "emdash/db";
import {
	HookPipeline,
	SchemaRegistry,
	type CreateFieldInput,
	type Database as EmdashDbSchema,
	type EmailMessage,
	type HttpAccess,
	type LifecycleEvent,
	type LogAccess,
	type PluginContext,
	type ResolvedPlugin,
	type UserInfo,
} from "emdash";

import { createPlugin } from "../../src/sandbox-entry.js";
import {
	COURSES_FIXTURE,
	LESSONS_FIXTURE,
	type CollectionFixture,
} from "../../src/setup/schema-fixtures.js";

/**
 * Options accepted by `createTestPluginCtx`.
 */
export interface CreateTestPluginCtxOptions {
	/**
	 * Stand-in for the request-level admin user. Defaults to a synthesized
	 * admin (role = 50). Tests that need an instructor or student override
	 * only the fields they care about.
	 */
	user?: Partial<UserInfo>;
	/**
	 * When `false`, skip provisioning the `courses` / `lessons` collections.
	 * Used by setup-wizard integration tests that want to observe the
	 * pre-wizard state.
	 */
	withCollections?: boolean;
	/**
	 * URL → canned `Response` map. Any `ctx.http.fetch(url)` call looks up
	 * this table; unmapped URLs throw, which is the intended failure mode
	 * (tests must declare every outbound request).
	 */
	fakeHttp?: Record<string, Response>;
}

/**
 * What `createTestPluginCtx` hands back.
 */
export interface TestPluginCtx {
	/** Ready-to-use plugin context with spies wired. */
	ctx: PluginContext;
	/** Underlying Kysely handle — for seed helpers and direct assertions. */
	db: Kysely<EmdashDbSchema>;
	/** Every email `ctx.email.send` was called with, in call order. */
	outbox: EmailMessage[];
	/** Synthesized user info — tests mutate freely if they need to. */
	user: UserInfo;
	/** Closes the DB. Safe to call twice. */
	teardown: () => Promise<void>;
}

/**
 * Associates each test ctx with its backing Kysely handle. Exported via
 * `getTestDb` so `seed.ts` can insert into core tables (e.g. `users`) that
 * have no plugin-surface write path. Keyed by ctx identity so parallel test
 * files never collide.
 */
const TEST_DB_MAP: WeakMap<PluginContext, Kysely<EmdashDbSchema>> = new WeakMap();

/**
 * Retrieve the Kysely handle bound to a test-created PluginContext. Throws
 * if the ctx did not originate from `createTestPluginCtx` — the lookup is
 * strict so accidental production use is an immediate crash, not silent
 * corruption.
 */
export function getTestDb(ctx: PluginContext): Kysely<EmdashDbSchema> {
	const db = TEST_DB_MAP.get(ctx);
	if (!db) {
		throw new Error(
			"getTestDb: ctx was not produced by createTestPluginCtx — refusing to operate on a non-test ctx.",
		);
	}
	return db;
}

const DEFAULT_USER: UserInfo = {
	id: "user_admin_test",
	email: "admin@test.local",
	name: "Test Admin",
	role: 50, // @emdash-cms/auth Role.ADMIN
	createdAt: "2026-01-01T00:00:00.000Z",
};

function buildUser(partial: Partial<UserInfo> | undefined): UserInfo {
	return { ...DEFAULT_USER, ...partial };
}

const silentLog: LogAccess = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

function buildHttp(fakeHttp: Record<string, Response>): HttpAccess {
	return {
		async fetch(url: string, _init?: RequestInit): Promise<Response> {
			const canned = fakeHttp[url];
			if (!canned) {
				throw new Error(
					`test-plugin-ctx: no fakeHttp entry for ${url}. ` +
						`Register it via createTestPluginCtx({ fakeHttp: { "${url}": new Response(...) } }).`,
				);
			}
			// Clone so repeated calls to the same URL get independent bodies.
			return canned.clone();
		},
	};
}

async function provisionCollection(
	registry: SchemaRegistry,
	fixture: CollectionFixture,
): Promise<void> {
	await registry.createCollection(fixture.create);
	if (fixture.postCreateUpdate) {
		await registry.updateCollection(fixture.create.slug, fixture.postCreateUpdate);
	}
	// Fields go in parallel: `sortOrder` is set from the source index so
	// final ordering is independent of resolution order. Fixture `locked`
	// is a plugin concern (rename-detection in the wizard); the registry
	// only wants the emdash-native subset.
	await Promise.all(
		fixture.fields.map((field, i) => {
			const { locked: _locked, ...rest } = field;
			const input: CreateFieldInput = { ...rest, sortOrder: i };
			return registry.createField(fixture.create.slug, input);
		}),
	);
}

/**
 * Materialize a plugin context suitable for integration tests.
 */
export async function createTestPluginCtx(
	opts: CreateTestPluginCtxOptions = {},
): Promise<TestPluginCtx> {
	const sqlite: BetterSqliteDatabase = new DatabaseConstructor(":memory:");
	const db = new Kysely<EmdashDbSchema>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	await runMigrations(db);

	if (opts.withCollections !== false) {
		const registry = new SchemaRegistry(db);
		await provisionCollection(registry, COURSES_FIXTURE);
		await provisionCollection(registry, LESSONS_FIXTURE);
	}

	const resolved = createPlugin();
	const realInstall = resolved.hooks["plugin:install"]?.handler;

	let captured: PluginContext | undefined;
	// Clone the resolved plugin with a wrapped install hook so we can grab
	// the ctx the pipeline hands us, then delegate to the real handler (which
	// seeds `settings:*` KV defaults + the `state:bootstrap` record).
	const captureHandler = async (event: LifecycleEvent, ctx: PluginContext): Promise<void> => {
		captured = ctx;
		if (realInstall) {
			await realInstall(event, ctx);
		}
	};
	// Tests exercise `ctx.content.create(...)` and `ctx.users.*`; real v1
	// production hook-paths don't need those today, but the fixture should
	// give engine/route tests the fullest possible ctx. These capabilities
	// are grants, not requirements — the plugin itself is unaffected.
	const testCapabilities = Array.from(
		new Set([...resolved.capabilities, "read:content", "write:content", "read:users"]),
	) as ResolvedPlugin["capabilities"];

	const wrapped: ResolvedPlugin = {
		...resolved,
		capabilities: testCapabilities,
		hooks: {
			...resolved.hooks,
			"plugin:install": {
				// The one hook config field that matters here; keep the others
				// at their resolved defaults.
				priority: 100,
				timeout: 5000,
				dependencies: [],
				errorPolicy: "abort",
				exclusive: false,
				pluginId: resolved.id,
				handler: captureHandler,
			},
		},
	};

	const pipeline = new HookPipeline([wrapped], { db });
	const installResults = await pipeline.runPluginInstall(resolved.id);
	const failed = installResults.find((r) => !r.success);
	if (failed) {
		throw failed.error ?? new Error("plugin:install hook threw an unknown error");
	}

	if (!captured) {
		throw new Error(
			"test-plugin-ctx: plugin:install hook never fired — the fixture could not capture a PluginContext.",
		);
	}

	const outbox: EmailMessage[] = [];
	const testCtx: PluginContext = {
		...captured,
		log: silentLog,
		email: {
			async send(message: EmailMessage): Promise<void> {
				outbox.push(message);
			},
		},
		http: buildHttp(opts.fakeHttp ?? {}),
	};

	const user = buildUser(opts.user);

	TEST_DB_MAP.set(testCtx, db);

	let tornDown = false;
	async function teardown(): Promise<void> {
		if (tornDown) return;
		tornDown = true;
		TEST_DB_MAP.delete(testCtx);
		await db.destroy();
		sqlite.close();
	}

	return { ctx: testCtx, db, outbox, user, teardown };
}

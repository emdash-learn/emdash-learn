# RFC: Plugin Schema API for emdash (`ctx.schema.*`)

**Status:** Draft  
**Author:** lms-core team  
**Date:** 2026-04-21  
**Related finding:** AUDIT C4, C5 in `@emdash/lms-core` v1 pre-release audit  
**Target emdash version:** 0.6.0 or later

---

## Summary

This RFC proposes adding a `schema` sub-object to the emdash `PluginContext` that gives plugin hooks in-process, permission-checked access to collection lifecycle operations:

```ts
interface PluginSchemaAccess {
  createCollection(input: CreateCollectionInput): Promise<RemoteCollection>;
  updateCollection(slug: string, patch: UpdateCollectionInput): Promise<RemoteCollection>;
  deleteCollection(slug: string, opts?: { force?: boolean }): Promise<void>;
}
```

The surface is analogous to the existing `ctx.content`, `ctx.kv`, and `ctx.storage` sub-objects: injected by emdash core, restricted by capability, and unavailable if the plugin has not declared the necessary capability in its descriptor.

---

## Motivation

### Current state (v1 workaround)

`@emdash/lms-core` needs to provision three content collections (`courses`, `lessons`, `topics`) during install and destroy them during uninstall. Without a server-side schema API, neither can happen in the plugin hook context:

1. **`plugin:install` hook** — collection provisioning cannot run because it requires the `schema:manage` permission, which is only available to authenticated admin sessions. The install hook runs with no browser cookies. Today, provisioning is deferred to the setup wizard (`SetupWizardPage.tsx`) which runs in the admin browser session and calls `/_emdash/api/schema/*` via `CoreSchemaClient`. This means `pnpm add + register` alone does not produce a working installation; the admin must manually navigate to the wizard and click through it.

2. **`plugin:uninstall({ deleteData: true })` hook** — collection deletion fails silently. The hook tries `fetch("/_emdash/api/schema/collections/...")` with no auth headers, receives 401, logs a warning, and exits successfully. Authored content (courses, lessons, topics) is never deleted. Admins who asked for "delete data" discover their content is still intact on reinstall. This is both a correctness failure and a GDPR-adjacent data-lifecycle issue.

**The v1 workaround (this audit track):** make `plugin:uninstall` fail loudly instead of silently, directing admins to the wizard's "Drop plugin data" panel. This is documented honestly in the README but is a worse user experience than an atomic uninstall.

### Why the platform should own this

The `/_emdash/api/schema/*` endpoints exist and work. The permission model (`schema:manage`) is already enforced there. The gap is that plugin lifecycle hooks do not have a way to call those endpoints authentically — there is no ambient credential in the hook context.

The cleanest fix is to inject an in-process `ctx.schema` object that:
- Is pre-authorized by emdash core (the platform already trusts the plugin's declared capabilities).
- Does not require a session cookie or a separate HTTP round-trip.
- Is only available when the plugin has declared the `schema:manage` capability (or a new `schema:write` capability; see below).

---

## Proposed API

```ts
// Added to PluginContext in emdash/packages/core/src/plugins/types.ts:
interface PluginContext {
  // ... existing fields ...

  /**
   * In-process schema operations. Only injected when the plugin has declared
   * the `schema:write` capability in its descriptor. Undefined otherwise.
   */
  schema?: PluginSchemaAccess;
}

interface PluginSchemaAccess {
  /**
   * Create a new content collection. Equivalent to POST /api/schema/collections.
   * Throws if a collection with the same slug already exists (409 Conflict),
   * unless the plugin handles the conflict.
   */
  createCollection(input: CreateCollectionInput): Promise<RemoteCollection>;

  /**
   * Update metadata on an existing collection. Equivalent to
   * PUT /api/schema/collections/:slug. Does not modify fields.
   */
  updateCollection(slug: string, patch: UpdateCollectionInput): Promise<RemoteCollection>;

  /**
   * Delete a collection and optionally its content entries.
   * `force: true` is required when the collection contains entries.
   * Throws when the collection does not exist unless the caller catches 404.
   */
  deleteCollection(slug: string, opts?: { force?: boolean }): Promise<void>;
}
```

### Capability model

We propose a new `schema:write` capability (distinct from the existing content capabilities) because schema mutations carry a different risk profile from content reads/writes:

- A plugin with `read:content` or `write:content` cannot break another plugin's data model.
- A plugin with `schema:write` can rename or delete a collection, breaking any content or query that references it.

Operator review of `schema:write` capability grants should be mandatory in the emdash plugin activation UI, similar to how `email:send` is surfaced.

`ctx.schema` is `undefined` when `schema:write` is not declared. Plugin code must handle the `undefined` case gracefully to remain compatible across host versions.

### Call site (what lms-core would look like after this ships)

```ts
// src/sandbox-entry.ts

"plugin:install": async (_event, ctx) => {
  await seedDefaultSettings(ctx);
  if (ctx.schema) {
    // Provision collections in-process; idempotent (catches 409 Conflict).
    for (const fixture of [COURSES_FIXTURE, LESSONS_FIXTURE, TOPICS_FIXTURE]) {
      try {
        await ctx.schema.createCollection(fixture.create);
      } catch (err) {
        if (isConflict(err)) continue; // already exists
        throw err;
      }
    }
    await ctx.kv.set(BOOTSTRAP_STATE_KEY, { version: BOOTSTRAP_VERSION, completedSteps: [] });
  } else {
    // Fallback for hosts that do not yet support schema:write.
    await ctx.kv.set(BOOTSTRAP_STATE_KEY, { version: 0, completedSteps: [] });
  }
},

"plugin:uninstall": async (event, ctx) => {
  if (!event.deleteData) return;
  if (ctx.schema) {
    for (const slug of [TOPICS_COLLECTION_SLUG, LESSONS_COLLECTION_SLUG, COURSES_COLLECTION_SLUG]) {
      await ctx.schema.deleteCollection(slug, { force: true }).catch(() => {});
    }
  }
  // plugin storage is dropped by emdash core automatically
},
```

---

## Alternative: what lms-core ships without `ctx.schema`

Until this RFC is accepted and released:

1. **Install** remains a two-step process: `pnpm add` + run the setup wizard. The README explicitly documents this. Every non-setup route returns `LEARN_SETUP_INCOMPLETE` (409) with a `setupPath` detail when the bootstrap state is below `BOOTSTRAP_VERSION`, so unauthenticated/misconfigured installs fail with a structured, actionable error rather than empty responses.

2. **Uninstall with deleteData** throws loudly if content collections still have data, directing the admin to use the wizard's "Drop plugin data" panel before uninstalling. Plugin storage (enrollments, progress, certificates) is still dropped automatically by emdash core.

This workaround is strictly better than the previous silent-fail, but is worse UX than an atomic `ctx.schema.deleteCollection` call.

---

## Security considerations

- **Scope creep risk:** a plugin with `schema:write` can create arbitrarily named collections, delete collections it does not own, or rename existing ones. emdash should consider whether `schema:write` should be scoped to the plugin's own namespace (e.g. only collections with a `plugin_id` matching the caller), or whether the capability model already handles this via activation-time review.
- **No browser session required:** the whole point of `ctx.schema` is to remove the dependency on a browser session. emdash core must enforce authorization at the `SchemaRegistry` call site, not at the HTTP handler.
- **Field-level operations:** this RFC does not propose `ctx.schema.createField` or `ctx.schema.updateField`. Field management can remain wizard-only for v1.1 — it is less lifecycle-critical and poses higher risk of accidental schema damage.
- **Conflict and 404 semantics:** implementors should ensure that `createCollection` on an existing slug is idempotent by convention (return existing + warn) or raises a typed conflict error that callers can handle.

---

## Open questions

1. Should `schema:write` be namespaced? (`schema:write:own` vs `schema:write:any`)
2. Should `ctx.schema` be injected into all hook contexts (install, uninstall, cron), or only lifecycle hooks?
3. Should emdash expose `SchemaRegistry` directly, or maintain the HTTP-layer abstraction inside the injected `PluginSchemaAccess` object?

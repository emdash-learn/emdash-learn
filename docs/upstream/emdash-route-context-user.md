# emdash: `RouteContext.user` missing — plugins can't do owner-scoped authz

**Status:** bug / missing feature in emdash core
**Repro version:** `emdash@0.5.x` (installed via the lms-core plugin's demo)
**Filed:** pending (this doc is the draft body for the GitHub issue)
**Contact plugin that hit it:** `@emdash/lms-core` (see `src/authz.ts` + `src/routes/*.ts`)

---

## Summary

Emdash resolves `locals.user` from the session cookie before dispatching a plugin API route, then discards it. The resulting `RouteContext` passed to plugin handlers exposes `{ input, request, requestMeta }` — no caller identity. Every plugin that wants per-user ("owner") authz is structurally unable to implement it.

The fix is a ~20-line diff across four files in `packages/core`. The data is already resolved and the plugin-safe `UserInfo` type is already defined — emdash just needs to forward it.

## Impact

- Plugins cannot implement §6.1-style "owner" auth (user may act on their own enrollments/progress/attempts) without either (a) going fully public, (b) admin-gating everything, or (c) reaching into emdash's session storage internals.
- `@emdash/lms-core` has ~15 student/owner/editor routes (`enroll`, `progress:tick`, `progress:complete`, `quiz:submit`, `my-learning`, `certificates:mine`, `curriculum`, `lesson`, `unenroll`, etc.) — **all return `LEARN_UNAUTHENTICATED` at runtime regardless of session**, because `ctx.user` is always `undefined`.
- `packages/plugins/audit-log` does not hit this because it listens to content hooks (which receive actor ids in the event payload). Any future plugin that exposes HTTP routes to authenticated users will hit it immediately.

## Reproduction

1. Install a plugin that declares a private route and checks the caller's identity:

   ```ts
   const enrollRoute: PluginRoute<EnrollInput> = {
   	input: enrollInput,
   	handler: async (ctx) => {
   		const user = (ctx as any).user; // always undefined
   		if (!user) throw PluginRouteError.unauthorized();
   		// …
   	},
   };
   ```

2. In a demo site, authenticate via `/_emdash/api/auth/dev-bypass?redirect=/`. Confirm the `astro-session` cookie is present.
3. POST to the plugin route with that cookie:

   ```
   curl -X POST /_emdash/api/plugins/<plugin>/enroll \
     -H "Content-Type: application/json" \
     -H "X-EmDash-Request: 1" \
     -b cookies.txt -d '{"courseId":"…","source":"free"}'
   ```

4. Expected: the handler sees the calling user.
   Actual: 401, because `ctx.user` is `undefined`.

Compare with `setup:state` (which doesn't read `ctx.user`) — that route works fine with the same cookie. The session IS being resolved; it's just never passed to the plugin.

## Root cause (code tour)

All paths on `packages/core/src/**`.

1. `astro/middleware/auth.ts:349-360` — for plugin routes, the session is decoded and `locals.user` is populated with the plugin-safe `UserInfo` shape. Good.
2. `astro/routes/api/plugins/[pluginId]/[...path].ts:23` — the API handler destructures `const { emdash, user } = locals`.
   Line 46 calls `requirePerm(user, permission)` to gate private routes — so at this point `user` is known and trusted.
   Line 68 calls `emdash.handlePluginApiRoute(pluginId, method, ` /${path}`, request)` — **`user` is not forwarded.**
3. `emdash-runtime.ts:2051` — `handlePluginApiRoute(pluginId, _method, path, request)` has no user param. It calls `routeRegistry.invoke(pluginId, routeKey, { request, body })` — nowhere to put user.
4. `plugins/routes.ts:62,96-103` — `PluginRouteHandler.invoke(routeName, options)` constructs a `RouteContext` from the base plugin context + `{ input, request, requestMeta }`. **There's no `user` key.**
5. `plugins/types.ts:1068` — `interface RouteContext<TInput> extends PluginContext { input; request; requestMeta; }` — no `user`.

## Is this an intentional security boundary?

Probably not. Five signals it's incompleteness, not policy:

1. **The work is already done.** Middleware fully resolves the session and populates `locals.user`. Line 46 uses it. Line 68 simply forgets to thread it through. No comment explains the drop.
2. **`UserInfo` is the scrubbed, plugin-safe shape.** `plugins/types.ts:361` defines it as "Read-only user information exposed to plugins" — `{ id, email, name, role, createdAt }`. No password, no tokens, no internal flags. Exposing this via `RouteContext` is strictly less data than `ctx.users.get()` returns for any user in the system (and `read:users`-capable plugins can already enumerate).
3. **No capability wall.** Every sensitive surface (content, media, users, email, network) has a named capability. There is no "identify caller" capability, no comment saying "plugins cannot see the session user", and nothing in `skills/creating-plugins/SKILL.md` about how to implement owner-scoped routes without one.
4. **The test surface assumes the contract.** `@emdash/lms-core/tests/utils/test-plugin-ctx.ts:260` builds a `user` field, and `routes/analytics.test.ts:makeRouteCtx` merges it into the ctx with the inline comment _"matching the shape emdash passes to plugin route handlers"_. Whoever wrote that assumed emdash passes user. It doesn't.
5. **Peer systems expose the caller.** WordPress (`wp_get_current_user()`), Shopify Admin API (session token), Sanity (`useClient` with token), Contentful (Sys.createdBy) — all expose the calling identity to their plugin/extension layer. Hiding it is unusual enough that a deliberate choice would be called out in the docs.

### Security review of exposing `user`

- Plugins with `read:users` can already enumerate the full user table (`ctx.users.list()`, `ctx.users.get(id)`, `ctx.users.byEmail(email)`). Telling them which of those users is the caller is strictly less privileged than what they already have.
- Plugins without `read:users` would see `{ id, email, name, role, createdAt }` for exactly one user — the party who chose to POST to the plugin. The caller's identity was implicitly disclosed the moment they clicked. This is not a privacy delta.
- Token-authed requests (`locals.tokenScopes` set, no session user) would surface `user: null`. Plugin handlers would treat that like any other unauthenticated caller. No regression for API-token clients.

## Proposed fix

Four small edits, all additive:

```ts
// packages/core/src/plugins/types.ts
export interface RouteContext<TInput = unknown> extends PluginContext {
  input: TInput;
  request: Request;
  requestMeta: RequestMeta;
+ /**
+  * The session user resolved by emdash's auth middleware, or null for
+  * public routes / token-authed calls without a session cookie.
+  */
+ user: UserInfo | null;
}
```

```ts
// packages/core/src/plugins/routes.ts
export interface InvokeRouteOptions {
  request: Request;
  body?: unknown;
+ user?: UserInfo | null;
}

// inside PluginRouteHandler.invoke(...)
const routeContext: RouteContext = {
  ...baseContext,
  input: validatedInput,
  request: options.request,
  requestMeta: extractRequestMeta(options.request),
+ user: options.user ?? null,
};
```

```ts
// packages/core/src/emdash-runtime.ts  (signature + pass-through)
async handlePluginApiRoute(
  pluginId: string,
  _method: string,
  path: string,
  request: Request,
+ user: UserInfo | null = null,
) {
  // ...
  return routeRegistry.invoke(pluginId, routeKey, { request, body, user });
}
```

```ts
// packages/core/src/astro/routes/api/plugins/[pluginId]/[...path].ts
- const result = await emdash.handlePluginApiRoute(pluginId, method, `/${path}`, request);
+ const result = await emdash.handlePluginApiRoute(
+   pluginId,
+   method,
+   `/${path}`,
+   request,
+   locals.user ?? null,
+ );
```

`astro/types.ts` needs the matching signature bump on `handlePluginApiRoute`.

All existing plugins compile unchanged (the field is additive; readers cast through or ignore). Tests that currently fake `user` on the route ctx keep working — `createTestPluginCtx` can drop its manual merge once the field lands.

## Follow-ups once this is in

- Update `skills/creating-plugins/SKILL.md` with an "Owner-scoped routes" section: "read `ctx.user` for the caller; combine with `read:users` for cross-user lookups".
- Remove `makeRouteCtx` shim in consuming plugins' test suites (the test ctx already matches the real one).
- `@emdash/lms-core` can drop its `AuthContext` cast-through in `src/authz.ts` and rely on the native type.

## Version notes

Observed against the `emdash@0.5.x` installed in `@emdash/lms-core`'s demo. Source cross-check against the emdash working tree (no behavior difference; the types live in the same file in `HEAD`).

# Issues found while locally testing T28

Notes captured while walking through `docs/testing-t28-local.md` on commit `1aa9e69` (T28: topics primitive, ADR 0001). Each entry is shaped to be lifted directly into a GitHub issue — on the emdash repo unless noted.

Environment: macOS 25.3.0, node 24.6.0, pnpm 10.28.0. Sibling repo layout: `/Users/baezor/dev/lms-core` and `/Users/baezor/dev/emdash`, with `lms-core/node_modules/emdash -> ../../emdash/packages/core`.

---

## 1. BLOCKER — Plugin admin pages with `:param` keys are unreachable

**Repo:** `emdash`
**Severity:** blocker (T28 QA cannot proceed)
**Area:** `packages/admin` — plugin host / routing

### Summary

`usePluginPage` in `packages/admin/src/lib/plugin-context.tsx:54` does exact-string lookup against a plugin's `pages` record. Any plugin that registers admin pages with `:param` segments (e.g. `/courses/:courseId`) is never matched against concrete URLs like `/courses/01KPM311W3K15SKWD03H6NYD1K`. The router falls through to `SandboxedPluginPage` (Block Kit), which then 404s because the plugin never registered a matching Block Kit `admin` route.

### Repro

1. Use lms-core at `1aa9e69` (which registers `/courses/:courseId`, `/students/:userId`, `/cohorts/:cohortId`, `/courses/:courseId/lessons/:lessonId/topics/:topicId`, `/quizzes/:quizId` in `src/admin.tsx`).
2. In the demo, open `/_emdash/admin/plugins/lms-core/courses/<any-course-id>`.
3. Observe a `Plugin Error — Plugin responded with 404: {"error":{"code":"NOT_FOUND","message":"Plugin route not found"}}` banner. Dev-server log shows `404 POST /_emdash/api/plugins/lms-core/admin`.

### Evidence

- `packages/admin/src/lib/plugin-context.tsx:54–57` — exact-match only.
- `packages/admin/src/router.tsx:1609–1623` — `pagePath = "/" + _splat`, passed verbatim to `usePluginPage`; on null, falls back to `SandboxedPluginPage`.
- `packages/core/src/astro/integration/virtual-modules.ts:207–237` — `generateAdminRegistryModule` imports each plugin's admin exports unmodified; no build-time param-key transformation.
- Grep confirms no other matcher anywhere in `packages/admin`: no `matchPath`, `pathToRegexp`, `path-to-regexp` dep, colon-prefix key parsing, or regex over pages keys.
- All three existing in-repo plugins (`emdash-forms`, `api-test`, `ai-moderation`) use only static keys (`"/"`, `"/submissions"`, `"/test"`, `"/settings"`) — lms-core T28 is the first plugin attempting `:param` keys.

### Impact

Blocks every dynamic admin page in lms-core: course detail (Overview · Curriculum · Enrollments · Progress · Quizzes · Cohorts · Discussions · Settings tabs), topic editor, per-student progress page, cohort detail, quiz editor. §A.1–A.6 of `docs/testing-t28-local.md` are all unreachable.

### Proposed fix

Teach `usePluginPage` to match `:param` keys. ~15 lines:

```ts
export function usePluginPage(pluginId: string, path: string): React.ComponentType | null {
	const admins = useContext(PluginAdminContext);
	const pages = admins[pluginId]?.pages;
	if (!pages) return null;
	if (pages[path]) return pages[path];
	for (const key of Object.keys(pages)) {
		if (!key.includes(":")) continue;
		const pattern =
			"^" +
			key
				.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, "[^/]+") +
			"$";
		if (new RegExp(pattern).test(path)) return pages[key];
	}
	return null;
}
```

- Exact match wins (static `/courses/new` beats dynamic `/courses/:courseId`).
- `:word` matches one segment (`[^/]+`), same convention as TanStack/Express/React Router.
- Regex is anchored; static portions are regex-escaped before substitution.
- No change needed in lms-core — its pages already read params from `window.location.pathname` (see `CoursePage.tsx:89`, `StudentProgressPage.tsx:56`).

Consider parallel updates to widget/field lookups only if those are expected to support params; today they key by id/type, not path, so no change required.

### Open question

Should params be threaded through to the component via context or props, or is self-parsing from `window.location` the intended contract? Current lms-core pages self-parse, so the minimal patch above is enough — but formalizing a `usePluginPageParams()` hook would prevent every plugin from reinventing the parser.

---

## 2. Missing devDep: `@lingui/babel-plugin-lingui-macro`

**Repo:** `lms-core`
**Severity:** high (dev server crash on first request)
**Area:** `demos/simple`

### Summary

The admin UI (served from the sibling `emdash/packages/admin/src/`) uses `@lingui/macro`, which needs the companion babel plugin `@lingui/babel-plugin-lingui-macro` at transform time. Vite resolves it from the demo's cwd (`demos/simple/babel-virtual-resolve-base.js`), not from the admin source file's location, and neither `lms-core/package.json` nor `demos/simple/package.json` declares it.

### Repro

1. Fresh clone, `pnpm install`, `pnpm build` in `lms-core`.
2. `cd demos/simple && pnpm seed && pnpm dev`.
3. Visit `/_emdash/admin`. Server errors: `Cannot find package '@lingui/babel-plugin-lingui-macro' imported from .../demos/simple/babel-virtual-resolve-base.js`.

### Fix

Add to `demos/simple/package.json` devDependencies:

```json
"@lingui/babel-plugin-lingui-macro": "^5.9.5"
```

(Sibling emdash uses `5.9.4` via catalog; any `^5.9.x` works.)

---

## 3. Missing file: `demos/simple/lingui.config.js`

**Repo:** `lms-core`
**Severity:** high (dev server crash once #2 is fixed)
**Area:** `demos/simple`

### Summary

Once the babel macro plugin is installed, Lingui's transform fails with `Lingui was unable to find a config! Create 'lingui.config.js' file with LinguiJS configuration in root of your project (next to package.json)`. The demo ships no Lingui config, and cosmiconfig's upward search from `demos/simple` doesn't hit the sibling emdash repo's `lingui.config.ts`.

### Fix

Add `demos/simple/lingui.config.js`. Minimal working content, self-contained (no import from the sibling repo):

```js
/** @type {import('@lingui/conf').LinguiConfig} */
const config = {
	sourceLocale: "en",
	locales: [
		"en", "ar", "eu", "zh-CN", "zh-TW", "fr", "de", "ja", "ko", "pt-BR", "es-419", "pseudo",
	],
	pseudoLocale: "pseudo",
	catalogs: [
		{ path: "<rootDir>/locales/{locale}/messages", include: [] },
	],
	format: "po",
};
module.exports = config;
```

Locale list mirrors `emdash/packages/admin/src/locales/locales.ts` so extracted strings stay in sync.

---

## 4. Missing Vite `server.fs.allow` for sibling emdash repo

**Repo:** `lms-core`
**Severity:** high (dev server errors on admin route)
**Area:** `demos/simple/astro.config.mjs`

### Summary

After #2 and #3 are fixed, Vite blocks serving admin source files with `The request id "/Users/baezor/dev/emdash/packages/core/src/astro/routes/PluginRegistry.tsx" is outside of Vite serving allow list.` The demo's Vite config doesn't widen `server.fs.allow` to include the sibling repo.

### Fix

Add to `demos/simple/astro.config.mjs`:

```js
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	// ...
	vite: {
		server: {
			fs: {
				allow: [
					resolve(__dirname, "../.."),
					resolve(__dirname, "../../../emdash"),
				],
			},
		},
	},
});
```

Hard-codes the sibling path. An alternative is to resolve `emdash` via `require.resolve` or `import.meta.resolve` and walk to the repo root, but the sibling layout is fixed in the dev setup so hard-coding is fine for the demo.

---

## 5. Doc: wrong dev-bypass URL

**Repo:** `lms-core`
**Severity:** low (testing doc only)
**Area:** `docs/testing-t28-local.md` §3

### Summary

Doc instructs hitting `/_emdash/api/auth/dev-bypass?redirect=/_emdash/admin`. That endpoint signs you in but does NOT set `emdash:setup_complete`, so `/admin` bounces back to `/admin/setup`. The endpoint that both signs in and marks setup complete is `/_emdash/api/setup/dev-bypass`.

### Evidence

- `emdash/packages/core/src/astro/routes/api/setup/dev-bypass.ts:127` — `await options.set("emdash:setup_complete", true);`
- `emdash/packages/core/src/astro/routes/api/auth/dev-bypass.ts` — no such call.

### Fix

Update §3 in `docs/testing-t28-local.md`:

```diff
- http://localhost:4321/_emdash/api/auth/dev-bypass?redirect=/_emdash/admin
+ http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin
```

---

## 6. Doc: wrong nav path for per-student progress

**Repo:** `lms-core`
**Severity:** low (testing doc only)
**Area:** `docs/testing-t28-local.md` §A.6

### Summary

Doc says "Nav: **Emdash Learn → Students**" for the per-student progress page. No such sidebar entry exists. The plugin mounts the route only at `/students/:userId` (no list page), and the entry point is via a course's Progress tab.

### Fix

Update §A.6 navigation steps:

```diff
-1. Nav: **Emdash Learn → Students**.
-2. Pick **Alice Chen** (or whichever student has the most progress from the seed).
-3. Open her progress for **Getting Started with React**.
+1. Nav: **Emdash Learn → Courses → Getting Started with React**.
+2. Open the **Progress** tab.
+3. Click **Alice Chen**'s row.
```

Or add a top-level Students list page to lms-core (a bigger change — would need a new route + sidebar entry).

---

## Filing order

Recommended cadence:

1. **#1** — file against emdash first; it's the only true blocker. Everything else is either workable or doc-only.
2. **#2, #3, #4** — file against lms-core as one combined issue titled "Demo can't boot off a fresh clone at 1aa9e69" with three checkbox fixes. They're all in `demos/simple` and could land in a single PR.
3. **#5, #6** — file against lms-core as a doc PR. Low priority but quick.

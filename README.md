# Emdash Learn (`@emdash/lms-core`)

Open-source LMS plugin for [emdash](https://github.com/emdash-cms/emdash) — courses, lessons, server-graded quizzes, certificates with public verification, cohorts, and multi-instructor assignments. Runs as a native/trusted plugin (no Dynamic Worker Loader), persists content in emdash's content collections, and keeps learning state in plugin storage.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![pnpm workspaces](https://img.shields.io/badge/pnpm-workspaces-f9ad00)

## Install

```bash
pnpm add @emdash/lms-core
```

Peer deps (provided by your emdash site):

- `emdash >=0.5.0`
- `astro ^6.0.0`
- `react ^19.0.0` + `react-dom ^19.0.0`
- `@emdash-cms/blocks >=0.5.0`

## Quick start

Register the plugin in your site's `astro.config`:

```ts
// astro.config.mjs
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";
import { lmsCorePlugin } from "@emdash/lms-core";

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
			plugins: [lmsCorePlugin()],
		}),
	],
});
```

Start the site, then open the one-click setup wizard at
`/_emdash/admin/plugins/lms-core/setup` — it provisions the `courses`, `lessons`, and `topics` content collections, seeds defaults, and drops you on the teaching dashboard.

## What's in the box

**Content**

- `courses`, `lessons`, and `topics` content collections with rich Portable Text bodies, drafts, revisions, scheduling, SEO, and i18n.
- Inline quiz blocks via a custom Portable Text block type (native-plugin only).

### Topics

The content tree is **Course → Lesson → Topic**, mirroring LearnDash's `sfwd-topic` post type. Topics belong to a single lesson, denormalize their `course` reference for query locality, and ship with their own body, video, summary, ordering, and `requires_previous` gating. Topics intentionally do **not** have free-preview or independent drip — they inherit visibility and drip from the parent lesson per ADR 0001. See [`docs/adr/0001-topics-primitive.md`](./docs/adr/0001-topics-primitive.md) for the design decision.

**Learning engine**

- Enrollments, per-lesson progress with video resume, per-lesson drip gating (immediate + relative modes), sequential-lesson requirements, free-preview lessons.
- Server-graded quizzes with 4 question types (MCQ, multi-select, true/false, short-text), configurable time limits (hard/soft policy), optional randomization.
- Certificate records with unique verification codes and a public verify endpoint.
- Cohorts with capacity hints and CSV email import.
- Multi-instructor course assignment (lead / co / ta) via plugin storage.
- Lesson-level discussions via emdash's built-in comments.

**Admin**

- React admin pages mounted at `/_emdash/admin/plugins/lms-core/`.
- One-click setup wizard that provisions the Courses and Lessons content collections.
- Per-student progress drill-down across every enrolled course.

**Integrations**

- Reuses emdash's passkey / OAuth / magic-link auth — no plugin-side auth surface.
- Typed RPC over HTTP via the admin API client (`src/admin/api-client.ts`).

## Admin tour

All admin pages mount under `/_emdash/admin/plugins/lms-core/`:

| Path                                                   | Page                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `/`                                                    | Teaching dashboard (stats, recent activity)                                                                |
| `/setup`                                               | One-click setup wizard                                                                                     |
| `/courses/:courseId`                                   | Course detail — 7-tab layout (overview, curriculum, enrollments, quizzes, cohorts, instructors, analytics) |
| `/courses/:courseId/lessons/:lessonId/topics/:topicId` | Topic editor (portable-text body)                                                                          |
| `/quizzes`                                             | Quiz list                                                                                                  |
| `/quizzes/:quizId`                                     | Quiz authoring editor                                                                                      |
| `/cohorts`                                             | Cohorts list                                                                                               |
| `/cohorts/:cohortId`                                   | Cohort detail + CSV import                                                                                 |
| `/instructors`                                         | Instructor assignments                                                                                     |
| `/students/:userId`                                    | Per-student progress across all enrollments                                                                |
| `/settings`                                            | Plugin settings + test-email                                                                               |

## Site-side routes

Typed RPC endpoints under `/_emdash/api/plugins/lms-core/*` — call from theme pages or the site's server code:

**Public (no auth)**

- `catalog` — paginated published courses with `difficulty` + `search` filters.
- `certificate:verify` — public credential lookup by verification code.

**Student (auth required)**

- `enroll`, `unenroll`
- `curriculum`, `lesson`, `topic`, `my-learning`
- `progress:tick`, `progress:complete` (input is `{ stepType, stepId, … }`)
- `quiz:start`, `quiz:submit`
- `certificates:mine`

**Admin / instructor (auth + capability)**

- `quiz:list`, `quiz:create`, `quiz:update`, `quiz:delete`
- `topic:list`, `topic:get`, `topic:create`, `topic:update`, `topic:delete`, `topic:reorder`
- `cohort:list`, `cohort:get`, `cohort:create`, `cohort:add-member`, `cohort:remove-member`, `cohort:import`
- `instructor:list`, `instructor:set`, `instructor:unset`
- `instructor:*-analytics`, `admin:analytics-overview`, `admin:courses-comparison`, `admin:engagement-metrics`
- `admin:settings:get`, `admin:settings:update`, `admin:test-email`

## Demo

A full reference site lives in [`demos/simple/`](./demos/simple). It wires the plugin into Astro + emdash, seeds sample courses/lessons/quizzes, and ships the theme pages used by the E2E suite.

```bash
pnpm install
pnpm --filter ./demos/simple seed    # idempotent — safe to re-run
pnpm --filter ./demos/simple dev
```

Skip passkey setup locally with the dev-bypass URL:

```
http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin
```

The demo's `src/pages/` includes `catalog`, `my-learning`, `courses/[slug]`, `courses/[slug]/lessons/…`, `quizzes/[quizId]`, and `certificates/[code]` — copy them as a starting point for your own theme.

## Architecture

- **Native / trusted plugin** — no Dynamic Worker Loader. Runs in the emdash process and has direct access to `ctx.content`, `ctx.storage`, `ctx.kv`, `ctx.email`.
- **Content in content collections** — `courses` and `lessons` live in emdash's `ec_courses` / `ec_lessons` tables and get drafts, revisions, scheduling, SEO, and i18n for free.
- **State in plugin storage** — enrollments, progress, quiz attempts, certificates, cohorts, and instructor assignments use plugin storage with composite indexes (declared in `src/sandbox-entry.ts`).
- **Engine is pure** — `src/engine/*.ts` modules are deterministic, testable functions over `PluginContext`; routes (`src/routes/*.ts`) are thin wrappers that parse input + map `Result` errors to `PluginRouteError`.
- **Typed admin client** — `src/admin/api-client.ts` wraps every RPC route with a typed call + `LmsApiError`.

## Scripts

| Command                 | What it does                                |
| ----------------------- | ------------------------------------------- |
| `pnpm build`            | Bundle the plugin with `tsdown` to `dist/`. |
| `pnpm typecheck`        | Run `tsc --noEmit`.                         |
| `pnpm test`             | Run Vitest unit + integration suites.       |
| `pnpm test:unit`        | Unit tests only.                            |
| `pnpm test:integration` | Integration tests only.                     |
| `pnpm test:e2e`         | Run Playwright E2E against the demo site.   |
| `pnpm lint`             | Run `oxlint` with type-aware rules.         |
| `pnpm lint:quick`       | Run `oxlint -f json` (CI gate).             |
| `pnpm format`           | Format with Prettier.                       |
| `pnpm format:check`     | Check formatting without writing.           |

## Internationalization

The README and feature list mention i18n in two distinct senses:

- **Content-item translation** — `courses`, `lessons`, and `topics` are stored in emdash's content collections, which ship draft/revision/scheduling/SEO and full locale support out of the box. This works in v1.
- **Admin UI strings** — Every string in the React admin pages is hard-coded in English in v1. Lingui is configured in the repo but string extraction and compiled catalogs are deferred to v1.1. If you need localized admin UI today, fork the admin pages.

## License

MIT — see [`LICENSE`](./LICENSE).

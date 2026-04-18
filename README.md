# Emdash Learn (`@emdash/lms-core`)

Open-source LMS plugin for [emdash](https://github.com/emdash-cms/emdash).

> **Status:** Scaffold only (Wave 0 / T00). The engine, admin UI, routes, and
> setup wizard land in subsequent tasks (see `prd-plugin.md` §26).

## What it will ship (v1)

- `courses` and `lessons` content collections with rich Portable Text bodies.
- Inline quiz blocks via a custom Portable Text block (native plugin only).
- Enrollments, per-lesson progress with video resume, drip gating, free previews.
- Server-graded quizzes (MCQ, multi-select, true/false, short-text).
- Certificate records with public verification endpoint.
- Cohorts with CSV email import.
- Multi-instructor course assignment.
- React admin pages mounted under `/_emdash/admin/plugins/lms-core/`.
- A one-click setup wizard that provisions the required content collections.

See [`prd-plugin.md`](./prd-plugin.md) for the full product spec.

## Local development

Clone emdash beside this repo:

```
~/dev/
├── emdash/          # upstream CMS
└── lms-core/        # this repo
    └── demos/simple # astro demo wired to the plugin
```

```bash
pnpm install
pnpm build
pnpm --filter ./demos/simple dev
```

Then visit `http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`
to skip passkey setup and land in the admin. The plugin's sidebar entry should
appear immediately.

## Scripts

| Command             | What it does                                     |
| ------------------- | ------------------------------------------------ |
| `pnpm build`        | Bundle the plugin with `tsdown` to `dist/`.      |
| `pnpm typecheck`    | Run `tsc --noEmit`.                              |
| `pnpm test`         | Run Vitest unit + integration suites.            |
| `pnpm test:e2e`     | Run Playwright E2E against the demo site.       |
| `pnpm lint`         | Run `oxlint` with type-aware rules.              |
| `pnpm format`       | Format with Prettier.                            |

## License

MIT — see [`LICENSE`](./LICENSE).

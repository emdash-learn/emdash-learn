# Contributing to Emdash Learn

Thanks for helping improve `@emdash/lms-core`. This guide covers the fast path: reporting bugs, running the plugin locally, and shipping a PR.

## Reporting bugs

Open an issue at <https://github.com/emdash-cms/lms-core/issues>. Please include:

- Plugin version (`@emdash/lms-core` from your site's lockfile).
- emdash version, Astro version, Node/runtime.
- Minimal repro steps — ideally a diff against `demos/simple`.
- Expected vs. observed behaviour.

For security issues, do **not** open a public issue — email the maintainers instead.

## Local development

Clone emdash beside this repo so the workspace link resolves:

```
~/dev/
├── emdash/          # upstream CMS (from github.com/emdash-cms/emdash)
└── lms-core/        # this repo
    └── demos/simple # Astro demo wired to the plugin
```

```bash
git clone https://github.com/emdash-cms/lms-core.git
cd lms-core
pnpm install
pnpm --filter ./demos/simple seed    # idempotent
pnpm --filter ./demos/simple dev
```

Open <http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin> to skip passkey setup and land in the admin. The plugin's sidebar entry shows up at `/_emdash/admin/plugins/lms-core/`.

## PR flow

1. Fork the repo and create a feature branch off `develop` (`git checkout -b T27-my-change`).
2. Make the change. Keep the diff scoped — one concern per PR.
3. Run the full local gate before pushing:
   ```bash
   pnpm typecheck
   pnpm lint:quick
   pnpm format:check
   pnpm test
   pnpm test:e2e
   pnpm build
   ```
4. Add a changeset:
   ```bash
   pnpm changeset
   ```
   Pick the right bump (`patch` for fixes, `minor` for new features, `major` for breaking changes) and write a user-facing summary — this text lands verbatim in `CHANGELOG.md`.
5. Open a PR against `develop`. CI (`.github/workflows/ci.yml`) runs the same gates on every PR.

## Commit style

Match the existing log (`git log --oneline -20`): imperative mood, descriptive, no trailing period. Task/section references are welcome:

```
T27: README + CHANGELOG + CI + CONTRIBUTING + changeset (§27, §18.10)
fix(quiz): drop stale attempt cache when submission fails validation
feat(admin): add course detail page
```

Avoid Conventional Commits prefixes unless the change is purely `chore:`/`fix:` scoped — the log favours descriptive subjects over strict prefixes.

## Changeset workflow

We use [`@changesets/cli`](https://github.com/changesets/changesets):

- `pnpm changeset` — creates a markdown changeset file under `.changeset/`.
- `pnpm changeset version` — applies pending changesets, bumping `package.json` and regenerating `CHANGELOG.md`. Run this on the release branch only.
- `pnpm changeset status` — lists pending changesets.

Every change that affects `src/**` should ship with a changeset describing what a user sees.

## Code of conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Be respectful. Assume good faith. Help newcomers.

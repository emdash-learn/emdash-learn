# Maintainer release process

This repository uses Gitflow for branch ownership, Conventional Commits for
history, and Changesets for package versions and `CHANGELOG.md`.

## Permanent branches

- `main` is production. Every commit must be releasable and every package tag
  must point to a commit on this branch.
- `develop` is integration and remains the repository's default branch.

Both branches require pull requests, successful CI, resolved conversations,
and current base branches. Force pushes and deletion are disabled.

## Feature and maintenance work

1. Branch from `develop` using an allowed prefix:
   `feature/`, `fix/`, `refactor/`, `perf/`, `docs/`, `test/`, `ci/`, `build/`,
   or `chore/`.
2. Use Conventional Commits.
3. Add a Changeset for every package-facing change.
4. Open the pull request against `develop`.
5. Squash-merge with the Conventional Commit pull-request title.

Dependabot and the Changesets version branch also target `develop`.

## Repository automation prerequisite

The Changesets workflow must be allowed to open pull requests. Prefer enabling
**Allow GitHub Actions to create and approve pull requests** in the
`emdash-learn` organization Actions settings. If organization policy keeps that
setting disabled, add a fine-grained `CHANGESETS_TOKEN` repository secret with
read/write access to repository contents and pull requests. The workflow uses
that token when present and otherwise uses the repository `GITHUB_TOKEN`.

## Normal release

1. Merge the Changesets-generated `chore(release): version packages` pull
   request into `develop`. This updates package versions, consumes pending
   Changesets, and generates `CHANGELOG.md`.
2. Create `release/X.Y.Z` from the versioned `develop`.
3. Allow only release-blocking fixes on that branch. Each fix must still use a
   Conventional Commit and pass the complete release suite.
4. Open `release/X.Y.Z` against `main`.
5. Merge after all checks and conversations pass.
6. Create and push the signed `vX.Y.Z` tag on the resulting `main` commit.
7. The `release.yml` workflow verifies that the tag matches `package.json`,
   verifies the commit belongs to `main`, re-runs the release suite, publishes
   npm with provenance, and creates the GitHub release.
8. Open a `main` → `develop` synchronization pull request and merge it.

Never tag the release branch before it is merged into `main`.

## Hotfix

1. Create `hotfix/X.Y.Z` from `main`.
2. Add the fix, tests, and a patch Changeset.
3. Run `pnpm release:version` on the hotfix branch.
4. Open the hotfix pull request against `main`.
5. Merge, tag, and publish as above.
6. Merge `main` back into `develop`.

## npm authentication

The release workflow supports the `NPM_TOKEN` environment secret for the first
publication. After the package exists, configure npm trusted publishing:

- provider: GitHub Actions;
- organization: `emdash-learn`;
- repository: `emdash-learn`;
- workflow: `release.yml`;
- environment: `npm`;
- allowed action: `npm publish`.

The workflow grants `id-token: write` for npm and `contents: write` for the
GitHub release, uses npm 11.5.1 or newer, and runs on GitHub-hosted workers.
Once trusted publishing succeeds, revoke the long-lived publish token.
Configure the GitHub `npm` environment with a required maintainer approval when
more than one maintainer is available.

The first npm publication may require an `NPM_TOKEN` environment secret because
trusted publishing is configured against an existing package. Remove it after
the trusted publisher has completed a successful release.

## Local release verification

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm --dir demos/simple typecheck
pnpm --dir demos/simple build
pnpm test:e2e
pnpm audit --audit-level moderate
pnpm pack --dry-run
```

Before tagging, install the tarball into a temporary consumer and verify the
root, sandbox, admin, browser, and Astro exports.

## Changelog policy

Do not hand-edit released version headings in `CHANGELOG.md`. Write meaningful
Changeset summaries in user language; `pnpm release:version` produces the
version heading and grouped entries. Documentation corrections to unreleased
notes may be made before the release tag.

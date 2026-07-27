# EmDash Learn 0.1 release readiness

Date: 2026-07-26

Target: `@emdashlms/plugin@0.1.0`

Compatibility: published EmDash `^0.31.1`, Astro `^7.1.3`, and Node 22.12+

## Decision

Release a useful anonymous learning plugin on the current EmDash plugin API.
Do not block the first release on Core identity work and do not ship a private
identity substitute.

Version 0.1 includes published Courses and Lessons, Knowledge Check authoring
and self-grading, browser-local progress, anonymous aggregate engagement
reporting, setup, admin pages, and the Astro renderer.

It excludes learner accounts, server-side progress, Attempts, device-to-account
import, profile reporting, and account privacy-erasure routes.

## Branch strategy

- `release/0.1.0`: current-Core release candidate.
- `future/account-learning`: preserved, validated account-enabled
  implementation candidate.
- `archive/pre-release-refactor`: pre-release baseline retained for reference.

The future branch is not a source of version 0.1 requirements. Before it can
ship, it must be reconciled with the official Core contract proposed in
[emdash-cms/emdash#812](https://github.com/emdash-cms/emdash/issues/812).
[Core PR #1947](https://github.com/emdash-cms/emdash/pull/1947) is existing
upstream work and currently needs rebase; Learn should support that effort
rather than submit a competing principal design.

The official direction is `ctx.user` / `routeCtx.user` with full Core user
information on authenticated private routes. The preserved prototype's minimal
`principal` and authenticated-public-route behavior are not the upstream
contract.

## Contract audit

- [x] Plugin storage declares no user, role, Attempt, or Lesson-completion
      collection.
- [x] Sandbox registration exposes no account progress, Attempt-history,
      device-import, or privacy-erasure route.
- [x] Public self-grading creates no durable learner record.
- [x] Lesson completion writes browser-local progress only.
- [x] Public engagement is always classified as anonymous.
- [x] Admin reporting presents event totals as anonymous directional activity,
      not unique visitors.
- [x] Package metadata targets published EmDash `^0.31.1`.
- [x] Package files exclude dormant internal source and include only compiled
      entries plus the required Astro source export.
- [x] Canonical documentation describes the 0.1 contract and labels
      account-linked learning as future work.

## Security and privacy audit

- [x] Public content and assessments require published Course context.
- [x] Public route inputs are schema-bounded and POST-only.
- [x] Public assessment and observation paths use bounded abuse controls.
- [x] Grading does not persist raw answers or free text.
- [x] Reporting uses a fixed event vocabulary.
- [x] Reporting stores no copied profile data, contact data, raw IP address, or
      full user agent.
- [x] Reporting retention is 90 days with strict-cutoff pruning.
- [x] Telemetry failure cannot fail content delivery, grading, or browser
      progress.
- [x] No caller-supplied identity is accepted or inferred.

## Automated release gates

These entries are updated from the release branch, not copied from the future
account candidate.

- [x] Node 22 runtime confirmed (`v22.23.1`)
- [x] `pnpm install --frozen-lockfile`
- [x] `pnpm typecheck`
- [x] `pnpm lint` with zero warnings
- [x] all five GitHub Actions workflows pass local Actionlint validation
- [x] `pnpm format:check`
- [x] no formatting diff after the format gate
- [x] unit tests (94 passing)
- [x] integration tests (93 passing)
- [x] repository-policy tests (5 passing)
- [x] production package build
- [x] anonymous browser E2E suite (4 passing)
- [x] demo typecheck
- [x] demo production build
- [x] zero known dependency vulnerabilities at moderate severity or above
- [x] package exports pass Publint and Are the Types Wrong for ESM consumers
- [x] `pnpm pack --dry-run` contents inspected
- [x] packed root, sandbox, admin, browser, and Astro consumer imports/build
- [x] clean-checkout install and release suite

## Repository governance and automation

- [x] `main` exists as the production branch; `develop` remains the default
      integration branch.
- [x] Both permanent branches require pull requests, an up-to-date base,
      successful complete CI, and resolved conversations.
- [x] Force pushes and branch deletion are disabled; rules also apply to
      administrators.
- [x] Gitflow branch/base rules and Conventional Commit titles/commits are
      enforced in CI.
- [x] Local Husky hooks validate commit messages and run the release check
      before pushes.
- [x] Changesets owns semantic versions and `CHANGELOG.md`.
- [x] CI, dependency review, CodeQL, Dependabot, version-PR, npm publish, and
      GitHub release workflows/configuration are present.
- [x] Every GitHub Action reference is pinned to a full commit SHA, and GitHub
      rejects unpinned actions.
- [x] Secret scanning, push protection, Dependabot security updates, and
      private vulnerability reporting are enabled.
- [x] Discussions are enabled for support; the unused wiki is disabled.
- [x] Contribution, support, security, conduct, ownership, issue, and pull
      request policies are present.

## Publication gates requiring maintainer action

- [x] Create the independently owned `emdashlms` npm organization and confirm
      owner publishing rights for `@emdashlms/plugin`.
- [x] Push `release/0.1.0`, open pull request
      [#3](https://github.com/emdash-learn/emdash-learn/pull/3) against `main`,
      and pass CI, CodeQL, and dependency review.
- [ ] At organization level, allow Actions to create pull requests or add the
      documented fine-grained `CHANGESETS_TOKEN` repository secret.
- [ ] Configure the protected GitHub `npm` environment and first-publication
      `NPM_TOKEN`; after the first publish, configure npm trusted publishing and
      revoke the token.
- [ ] Obtain project maintainer review.
- [ ] Merge through the repository's required checks.
- [ ] Sign and push `v0.1.0`; let the release workflow publish npm and create
      the GitHub release.
- [ ] Merge `main` back into `develop`.
- [ ] Verify install and demo build from the published tarball.

The release pull request is open and passing. No npm publication has been
created.

## Deferred account-release gates

These apply only to a later account-enabled version:

- Core publishes the official authenticated plugin-route user contract.
- Learn adopts official `ctx.user.id` ownership rather than the prototype
  `principal` shape.
- Public versus private route authentication semantics are resolved upstream.
- Account progress, Attempts, idempotency, erasure, reporting attribution, and
  migrations receive fresh tests and security review.
- Compatibility is proven against the published Core package, not a sibling
  checkout.

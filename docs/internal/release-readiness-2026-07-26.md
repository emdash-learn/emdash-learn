# EmDash Learn 0.1 release readiness

Date: 2026-07-26

Target: `@emdash/lms-core@0.1.0`

Core compatibility: published EmDash `^0.31.1`

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

- `codex/learn-0.1`: current-Core release candidate.
- `codex/learn-account-future`: preserved, validated account-enabled
  implementation candidate.

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
- [x] `pnpm lint`
- [x] `pnpm format:check`
- [x] no formatting diff after the format gate
- [x] unit tests (93 passing)
- [x] integration tests (93 passing)
- [x] production package build
- [x] anonymous browser E2E suite (4 passing)
- [x] demo typecheck
- [x] demo production build
- [x] `pnpm pack --dry-run` contents inspected
- [x] packed root, sandbox, admin, browser, and Astro consumer imports/build
- [x] clean-checkout install and release suite

## Publication gates requiring maintainer action

- [ ] Confirm package name and npm publishing rights for
      `@emdash/lms-core`.
- [ ] Push the release branch and open the repository pull request.
- [ ] Obtain project maintainer review.
- [ ] Merge through the repository's required checks.
- [ ] Let Changesets produce version `0.1.0`.
- [ ] Publish the public npm package.
- [ ] Verify install and demo build from the published tarball.

No npm publish, remote branch push, or pull request creation is implied by
local release validation.

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

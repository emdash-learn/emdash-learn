# EmDash Learn release readiness

**Audit date:** 2026-07-26  
**Status:** Candidate implementation validated; blocked on Core 0.32.0 and
distribution gates  
**Compatible host target:** EmDash 0.32.0  
**Release order:** EmDash core first, Learn second  
**Repository decision:** Continue the in-place refactor; do not create a new
repository

## Executive status

The current implementation is a focused Learn plugin:

```text
EmDash 0.32.0 authenticated principal
                    │
                    ▼
              thin route adapters
                    │
      ┌─────────────┼──────────────┬──────────────┐
      ▼             ▼              ▼              ▼
 Course Publishing Assessment Learning Record Engagement Reporting
                                   │              │
                            Privacy Erasure   90-day Retention
```

The worktree now contains the canonical Course/Lesson projection, Assessment,
device and account progress, reporting, privacy erasure, setup, admin, and
Astro surfaces. The release is blocked by upstream core publication and
release-integration work, not by a need for plugin-owned user management.

EmDash owns signup, verification, credentials, sessions, users, roles, and the
authenticated route principal. Learn must never substitute a name/email/phone
form or a browser identity field for that contract.

## Implemented contract

The following are present in the current worktree and covered by focused unit
or integration tests:

- [x] One descriptor/runtime contract for capabilities, storage, static admin
      pages, and the `learnKnowledgeCheck` block.
- [x] Published-only Course/Lesson projections with explicit DTOs,
      authoritative-read checks, and stale-row reconciliation.
- [x] Server-derived `setup:run` convergence and `setup:state`; no
      client-declared completion or collection-drop UI.
- [x] Canonical Assessment drafts and four question types.
- [x] Immutable publication revisions, stable heads, archive, redacted
      presentation, anonymous self-grading, and Course-bound,
      principal-linked Attempts.
- [x] Server-graded, immutable Attempts with storage-enforced
      `(learnerKey, submissionId)` uniqueness. Concurrent retries converge and
      persisted results omit submitted answers, authored explanations, and
      free text.
- [x] Principal-derived, immutable Lesson Completion Facts with
      storage-enforced `(learnerKey, lessonId)` uniqueness, own Course
      progress, and device Lesson import routes.
- [x] Bounded browser device progress with reset, export, and import; anonymous
      self-check results remain device-only.
- [x] Fixed-vocabulary exact reporting over retained observations, keyed
      day-scoped account pseudonyms, `calculatedThrough`, score bands, and
      `verifiedAccountDays`.
- [x] `{ total, anonymous, verified }` actor breakdowns for every event metric
      and score band.
- [x] Best-effort reporting that cannot fail content delivery, grading, or
      progress.
- [x] Daily best-effort retention maintenance that deletes observations
      strictly older than 90 days without a non-transactional rollup step.
- [x] Principal-owned privacy erasure for Lesson Completion Facts, Attempts,
      and attributable raw observations. Raw erasure prunes overdue rows first
      and resolves all retained day-scoped learner pseudonyms in one indexed,
      paginated query independent of unrelated retained volume.
- [x] Static `/checks`, `/reports`, and `/setup` admin pages using canonical
      route contracts.
- [x] Canonical Astro `KnowledgeCheckBlock` export and block contract requiring
      `courseId` and `checkId`.
- [x] Browser client support for account completion, device fallback/import,
      progress reads, fail-open Course/Lesson open observations, and
      authenticated `eraseMyData()`.
- [x] Public assessment/observation abuse-control seam using keyed, bounded
      trusted-IP buckets and one installation fallback; User-Agent rotation
      cannot create fresh budgets.

These checks describe implementation evidence, not release evidence. The
package is still version `0.0.0`, its compatible core package is not installed
from a published 0.32.0 release, and the full clean-consumer gate remains
outstanding.

### Local validation snapshot

The final refactor worktree passed:

- 103 unit tests and 127 integration tests;
- TypeScript typecheck, type-aware lint, Prettier check, and `git diff --check`;
- the plugin build, demo Astro typecheck, and demo production build;
- four anonymous Chromium journeys through the canonical Astro component on
  published EmDash 0.31.1;
- `pnpm install --frozen-lockfile`; and
- `pnpm pack --dry-run`, whose allowlist contains only `dist`, `src`, the
  manifest, README, and license.

The authenticated native-host Chromium journey also passed against a local
build of the Core principal candidate. It covers setup locking and convergence,
session-derived account progress, device Lesson import, immutable Attempt
idempotency and conflict handling, cross-principal isolation, reporting actor
splits, `verifiedAccountDays`, and browser-client privacy erasure. The
worktree was restored to published EmDash 0.31.1 after that test; no sibling
link, override, or local tarball remains in the manifest or lockfile.

An isolated packed-consumer preflight loaded the root, sandbox, admin, and
browser exports, resolved the Astro export, and passed the copied demo's Astro
typecheck and production build. That preflight used published EmDash 0.31.1
and therefore emitted the expected `emdash ^0.32.0` peer warning; it does not
replace the final published-0.32.0 consumer gate.

The sibling core patch separately passed 90 focused core tests, one Cloudflare
sandbox test, seven workerd integration tests, all three package typechecks
and builds, the documentation build, repository lint, repository formatting,
and `git diff --check`.

These checks come from dirty development worktrees and are implementation
evidence only. The published-core rerun, clean-checkout, packed-consumer, and
prerelease gates below remain mandatory.

## Exact release blockers

### BLOCKER 1 — merge and publish the core principal contract

- [ ] Track the official EmDash 1.0 roadmap issue
      [#812](https://github.com/emdash-cms/emdash/issues/812) and implementation
      [PR #1947](https://github.com/emdash-cms/emdash/pull/1947); do not open a
      competing Core proposal or PR.
- [ ] Land and test the authenticated plugin-route caller in EmDash's current
      release line.
- [ ] Verify parity for native and adapted/sandbox route dispatch.
- [ ] Verify authenticated sessions expose only the minimal safe principal on
      both private and public plugin routes; anonymous requests expose none,
      disabled users are rejected, and route permission checks still run.
- [ ] Publish the first EmDash version that closes #812 with its own Changeset
      and migration/release notes.

Learn cannot release first or depend on an unpublished sibling checkout.

### BLOCKER 2 — consume published EmDash 0.32.0

The Learn peer target is already `emdash ^0.32.0`, but its development
dependency and lockfile cannot move to that target until the core package is
published.

- [ ] Change the Learn development dependency to the published 0.32.0 package.
- [ ] Regenerate the lockfile without workspace links, overrides, or local
      tarballs.
- [ ] Remove `src/routes/route-principal.ts` and use the published core
      principal type and route-context field directly.
- [ ] Confirm the compatible `@emdash-cms/blocks` version and align it if the
      core release requires a matching line.

### BLOCKER 3 — rerun authenticated native-host journeys on published Core

The gated authenticated suite passes through the native EmDash host against
the local Core principal candidate:

- [x] Account completion and Course progress persist across reloads and derive
      ownership from the core principal.
- [x] Device Lesson completions import after sign-in as `device_import` facts;
      anonymous self-check scores do not import as Attempts.
- [x] Authenticated submission creates one immutable Attempt, concurrent or
      identical retries return it, conflicting reuse fails, and another
      principal cannot read it or the learner's progress.
- [x] `privacy:erase-my-data` removes principal-linked facts and attributable
      observations from subsequent reports. Exercise it through the browser
      client's `eraseMyData()` method.
- [x] Administrator reporting preserves total/anonymous/verified actor counts
      and clearly distinguishes `verifiedAccountDays`.
- [x] Setup blocks product routes before convergence and unlocks them after a
      successful no-input `setup:run`.
- [ ] After Blocker 2, run
      `E2E_AUTHENTICATED=1 pnpm test:e2e tests/e2e/authenticated-native.spec.ts`
      against the exact published EmDash 0.32.0 dependency and make this
      journey mandatory in CI.

### BLOCKER 4 — pass clean distribution and prerelease gates

- [ ] Reconcile the final package version, manifests, lockfile, and Changeset.
- [ ] From a clean Node 22 checkout, pass:

  ```bash
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm lint
  pnpm format:check
  pnpm test
  pnpm build
  pnpm test:e2e
  pnpm pack --dry-run
  ```

- [ ] Install the packed artifact into a temporary consumer using published
      EmDash 0.32.0 and verify root, sandbox, admin, Astro, and browser exports.
- [ ] Verify no sibling links, secrets, database files, generated artifacts,
      or superseded modules ship.
- [ ] Publish a prerelease, run the complete demo against installed packages,
      and only then publish stable.

## Settled reporting-retention and erasure access

- Reports aggregate retained observations exactly; there is no Daily Rollup or
  compaction cursor.
- Raw observations are retained for 90 days. Daily best-effort maintenance
  deletes only rows strictly older than the cutoff.
- This bounded raw-event contract avoids claiming an atomic compaction
  capability that Core's current plugin storage API does not provide.
- Learn exposes authenticated erasure through
  `createLearnBrowserClient(...).eraseMyData()`. Each consuming site owns the
  learner-facing confirmation, success, and partial-failure recovery UX.

## Decisions that are no longer blockers

- Learn does not need plugin-owned registration, email verification/resend,
  phone verification, users, or roles.
- Learn does not need parameterized admin routes; selection uses query strings
  under exact static pages.
- Anonymous progress does not require server identity; it is explicitly
  browser-local.
- Reporting does not need copied profile PII. `verifiedAccountDays` is computed
  from day-scoped pseudonyms.
- Reporting does not need Daily Rollups in the first release; bounded raw
  observations preserve exactness on the current Core API.
- Enrollment, paid access, cohorts, certificates, assignments, drip
  scheduling, proctoring, and custom LMS roles are outside the first release.

## Release gate

Learn is releasable only after all four blocker sections are complete. The
non-negotiable sequence is:

```text
merge core principal
        ↓
publish EmDash 0.32.0
        ↓
install 0.32.0 in Learn and regenerate lockfile
        ↓
remove the temporary principal adapter
        ↓
rerun authenticated native-host E2E on published Core
        ↓
frozen install + pack + temporary consumer + prerelease
        ↓
publish Learn stable
```

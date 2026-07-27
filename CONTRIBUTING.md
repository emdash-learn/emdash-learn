# Contributing to EmDash Learn

Thanks for helping build `@emdash/lms-core`.

Read the [authoritative product scope](./docs/product-scope.md) and current
[release checklist](./docs/internal/release-readiness-2026-07-26.md) before
starting a change. Unreleased legacy LMS code and historical design documents
are not product requirements.

## Version 0.1 boundary

Version 0.1 targets the published EmDash 0.31 plugin API. Learn owns Course and
Lesson conventions, Knowledge Checks, browser-local progress, anonymous
engagement reporting, and setup.

Do not:

- add plugin-local signup, verification, credential, session, user, or role
  flows;
- collect names, email addresses, phone numbers, passwords, verification
  codes, or browser-supplied identity claims;
- present browser-local progress as an account record or durable credential;
- create server-side Attempts or Lesson completion records for public callers;
  or
- depend on an unpublished EmDash patch.

Account-linked learning is a separate future track. It may be reconsidered
after EmDash publishes its official authenticated plugin-route context. Do not
simulate that contract with request headers or caller-supplied IDs.

## Canonical contracts

Changes must preserve these boundaries:

- Course and Lesson are EmDash content collections; setup is additive and
  convergent.
- `setup:run` accepts `{}` only. The server derives verified setup completion
  after schema convergence and projection repair.
- Public content and assessment DTOs use explicit allowlists.
- Draft, scheduled, trashed, orphaned, and stale content stays private.
- The Portable Text block is `learnKnowledgeCheck` with required `courseId` and
  `checkId` fields. Do not reintroduce `lmsQuiz` or `quizId`.
- Published Knowledge Check revisions are immutable and grading targets an
  exact `revisionId`.
- Public self-checks are deterministically graded and create no server-side
  Attempt. Their optional result is browser-local.
- Lesson completion is browser-local and makes no learning-record request.
- Reporting is best-effort, anonymous, and uses a fixed event vocabulary.
- Reporting observations are retained for at most 90 days and aggregated
  exactly at query time.
- Every private route declares an explicit EmDash permission.
- Descriptor and runtime declarations share the canonical plugin contract.

Keep route adapters thin. Put invariants behind module interfaces and consume
shared schemas and DTOs from admin, Astro, runtime, demo, and tests rather than
duplicating them.

## Reporting security and privacy

Reporting changes must document:

- which event types are browser-claimed;
- every persisted field;
- retention and pruning behavior;
- whether each metric describes events or another explicitly named unit; and
- how failure remains outside the learning success path.

Never persist copied profile data, contact data, raw answers, free text, raw IP
addresses, or full user agents in reporting rows. Request metadata may be
transformed into a bounded, keyed rate-limit fingerprint but must not enter
reports. Never describe anonymous event totals as unique visitors.

## Test-driven changes

Start with the narrowest observable interface:

1. Add a failing test for the behavior.
2. Make the smallest implementation change that passes it.
3. Refactor while keeping the test green.

Use EmDash-supported storage and content stand-ins for integration behavior.
Route tests must exercise validation, permission metadata, publication guards,
CSRF expectations, and error mapping. Unsafe-cast object literals that bypass
the route or storage contract are not sufficient integration evidence.

Before opening a pull request, run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm test:e2e
```

For a release change, also inspect `pnpm pack --dry-run` and install the packed
artifact into a temporary consumer against published EmDash 0.31.

## Pull requests

Create a branch from `develop`, keep each pull request focused, and add a
Changesets entry for user-visible changes:

```bash
pnpm changeset
```

The first public release has no compatibility obligation to unreleased WIP
storage. After that release, storage and interface migrations require an
explicit compatibility plan.

## Content and uninstall behavior

Learn setup may add or verify Course and Lesson schema requirements, but those
collections contain administrator-owned content. Uninstall must not drop the
collections or delete authored content. EmDash may remove plugin-scoped
storage only when an administrator explicitly selects data deletion.

## Report a bug

Include the Learn and EmDash revisions, Node/Astro/runtime versions, a minimal
reproduction, and expected versus observed behavior. Do not disclose security
vulnerabilities publicly; follow [SECURITY.md](./SECURITY.md).

## Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).

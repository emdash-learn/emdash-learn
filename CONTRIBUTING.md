# Contributing to EmDash Learn

Thanks for helping build `@emdash/lms-core`.

Read the [authoritative product scope](./docs/product-scope.md) and current
[release checklist](./docs/internal/release-readiness-2026-07-26.md) before
starting a change. Unreleased legacy LMS code and historical design documents
are not product requirements.

## Core ownership and compatibility

EmDash core owns authentication, registration, account recovery, email
verification and resend, credentials, sessions, users, and roles. Learn owns
Course/Lesson conventions, assessments, device and account learning records,
privacy erasure, and engagement reporting.

The compatible host target is EmDash 0.32.0. Core must release the
authenticated plugin-route principal first; Learn must not publish against a
local patch, sibling link, or structural test double.

Do not:

- create plugin-local signup, verification, credential, session, user, or role
  flows;
- collect names, email addresses, phone numbers, passwords, or verification
  codes in Learn;
- accept `userId`, `learnerId`, email, role, or another identity claim from a
  learner request;
- simulate a principal with a client-controlled header; or
- create or mutate global EmDash users or roles.

Every personalized route must derive its opaque learner identity from the
authenticated principal supplied by core and must reject an absent principal
before touching personalized storage.

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
- Published knowledge-check revisions are immutable and grading targets an
  exact `revisionId`.
- Anonymous self-checks create no account Attempt. Their optional result is
  device-local.
- Authenticated Attempts are server-graded, immutable, and retry-idempotent.
- Raw submitted answers and free text are never persisted.
- Anonymous lesson state lives behind the browser `DeviceProgressStore`.
  Imported lesson completions become `device_import` facts; device self-check
  scores do not become verified Attempts.
- Authenticated lesson completion is monotonic; Course percentages are derived
  from current published Lessons.
- Reporting is best-effort, uses a fixed event vocabulary, and distinguishes
  anonymous activity from authenticated account activity.
- `verifiedAccountDays` counts distinct accounts per UTC day and is not a
  unique-person metric.
- Privacy erasure removes principal-linked completions, Attempts, and raw
  observations from subsequent reports.
- Reporting observations are retained for at most 90 days and are aggregated
  exactly at query time.
- Every private route declares an explicit EmDash permission.
- Descriptor and runtime declarations share the canonical plugin contract.

Keep route adapters thin. Put invariants behind module interfaces and consume
shared schemas and DTOs from admin, Astro, runtime, demo, and tests rather than
duplicating them.

## Reporting security and privacy

Reporting changes must document:

- which event types are browser-claimed and which follow server facts;
- every persisted field;
- retention and pruning behavior;
- erasure behavior;
- whether each metric describes anonymous activity, event totals, or verified
  account-days; and
- how failure remains outside the learning success path.

Never persist copied profile PII, raw answers, free text, raw IP addresses, or
full user agents in reporting rows. Request metadata may be transformed into a
bounded, keyed rate-limit fingerprint but must not enter reports. Never
describe an authenticated or email-verified account as a unique person.

## Test-driven changes

Start with the narrowest observable interface:

1. Add a failing test for the behavior.
2. Make the smallest implementation change that passes it.
3. Refactor while keeping the test green.

Use EmDash-supported storage/content stand-ins for integration behavior. Route
tests must exercise validation, permission metadata, principal derivation,
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
artifact into a temporary consumer against the published EmDash 0.32.0
package.

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

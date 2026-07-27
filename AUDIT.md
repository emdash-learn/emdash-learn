# `@emdashlms/plugin` v1 pre-release audit

Auditor: external staff engineer / software architect, performing a pre-release review.
Commit audited: `1aa9e69` on `develop`.
Date: 2026-04-20.

## Executive summary

The plugin has a clear architecture, well-isolated engine/route seams, a strong test harness (real SQLite, real migrations, real install hook), and sensible Zod validation at the transport boundary. But several load-bearing behaviours do not match what the README and CHANGELOG promise.

Three things would block a responsible v1 today:

1. **Engine events emit into a void.** `event-bus.on(...)` is called only in tests. In production, `enrollment:created`, `lesson:completed`, `topic:completed`, `course:completed`, and `quiz:attempted` have no handlers. The welcome / completion email and notify flows described in comments never run. The reconciler cron is a backstop for certificates only.
2. **Certificate verification codes use `Math.random()`** (`src/engine/certificates.ts:49`). These are publicly verifiable credentials. A non-CSPRNG is not acceptable for a v1 credentialing feature.
3. **Every curriculum read and every progress write scans the entire `lessons` and `topics` content collections and filters client-side** (`src/engine/curriculum.ts:86-135`, `src/engine/progress.ts:103-170`). A single `progress:tick` that crosses 90% on a site with a few dozen courses already costs thousands of row reads. This will not survive real load on Workers or on SQLite at scale; it is also a subrequest blow-up risk under Cloudflare's 1000-subrequest cap.

There are additional high-severity issues around `plugin:uninstall` silently failing to drop content collections, `quiz:start` having no enrollment gate, `quiz:submit` trusting a client-supplied `lessonId` for auto-complete, `plugin:install` not actually provisioning collections (installation is not complete until the admin opens the wizard), and a race that turns "enrolled twice" from a clean 409 into a 500.

Confidence: **medium-high**. I read all 12 route modules, all engine modules, all hooks/reconcilers, the authz layer, the api-client, the setup surface, the demo theme, tests (unit + integration index, several spec bodies), CI, and the changeset config. I cross-referenced the emdash plugin contract (context, route dispatch, storage/unique indexes, hook signatures, schema API auth) against the plugin's usage. I did not execute the code, run tests, or exercise the binary.

## Scope and method

### Read in full

- `src/index.ts`, `src/sandbox-entry.ts`, `src/constants.ts`, `src/kv-keys.ts`, `src/authz.ts`, `src/admin.tsx`
- All of `src/engine/` (13 files, ~1,500 LOC of business logic)
- All of `src/routes/` (12 route modules)
- All of `src/hooks/` (content, comment, cron)
- All of `src/reconcilers/` (3 files)
- All of `src/setup/` (steps, schema-fixtures, core-schema-client)
- All of `src/types/`
- `src/admin/api-client.ts`, `src/admin/SetupWizardPage.tsx`, header of `src/admin/CoursePage.tsx`
- README, CHANGELOG, CONTRIBUTING, LICENSE, package.json, tsconfig.json, tsdown.config.ts, .changeset/config.json, .changeset/initial-release.md, .github/workflows/ci.yml
- `docs/adr/0001-topics-primitive.md`, `docs/emdash-issues-from-t28.md`
- `demos/simple/astro.config.mjs`, `demos/simple/package.json`, `demos/simple/src/lib/lms-api.ts`, all five `demos/simple/src/pages/*.astro`
- `tests/utils/test-plugin-ctx.ts`, `tests/unit/authz.test.ts`, heads of `tests/integration/engine/progress.test.ts` and `enrollments.test.ts`, `tests/e2e/quiz-taking.spec.ts`

### Skimmed (structure + contracts, not line-by-line bodies)

- Remaining admin React pages (`CoursePage.tsx` past line 200, `QuizEditPage.tsx`, `CohortDetailPage.tsx`, etc.)
- Remaining test files (spec titles + `describe` blocks to gauge coverage)
- `demos/simple/scripts/seed-lms.ts` (presence, shape)

### Referenced externally

- `/Users/baezor/dev/emdash/packages/` — queried the plugin-contract surface via a sub-agent (PluginContext fields, route dispatch, CSRF, hook signatures, storage guarantees). Used to distinguish platform responsibility from plugin responsibility.

### Not audited (see Out of scope)

- Bundle analysis / tree-shaking behaviour of the built `dist/`.
- The `prd-plugin.md`, `prompt-topics-refactor.md`, `emdash-learn-viability.md` files (these are internal planning docs, not shipped behaviour).
- Individual admin React pages for full behaviour — spot-read only.

---

## Critical — must fix before v1

### C1. Engine events emit into a void; every documented "event-driven" flow is silently broken

**Evidence.** `src/engine/event-bus.ts:43-64` exposes `emit()`, which dispatches to handlers registered via `on()`. `emit()` is imported in `src/engine/enrollments.ts:42`, `src/engine/progress.ts:35`, and `src/engine/quizzes.ts:36`. `on()` is called **zero** times anywhere under `src/`:

```
$ rg '^\s*on\s*\(' src/
(no matches)
```

`on()` is only called from integration tests (e.g. `tests/integration/engine/enrollments.test.ts:46`), which then reset via `__resetHandlersForTests()`.

Events that emit and have no consumer in production:
- `enrollment:created` (critical) — `src/engine/enrollments.ts:226-234`
- `enrollment:revoked` — `src/engine/enrollments.ts:269-276`
- `lesson:completed` (critical) — `src/engine/progress.ts:473-479`
- `topic:completed` (critical) — `src/engine/progress.ts:372-378`
- `course:completed` (critical) — `src/engine/progress.ts:492-498`
- `quiz:attempted` — `src/engine/quizzes.ts:413-420`

**Why it matters.**
- The enrollment "welcome email" flow described in `src/engine/enrollments.ts:12-13` does not exist. No handler for `enrollment:created` writes to `email-queue.send()`.
- The course-completion "completion email / cert notify" flow implied by `src/reconcilers/issue-certificates.ts:9` does not exist as an event handler either. Certificates are issued by the **reconciler** sweeping every `completedAt && !revokedAt` enrollment, which works — but nothing else runs on course completion.
- The `critical: true` flag on these events gives a false sense of delivery guarantees. Code comments repeatedly promise "downstream handlers can fan out" (`src/engine/enrollments.ts:12`) — there are no downstream handlers.
- Tests pass because they register handlers in-test and assert the emit succeeded. Production behaviour is untested.

**Fix.** Either (a) register the production handlers (welcome email, drip reset on enrollment, completion email, instructor notify) in `sandbox-entry.ts` at plugin creation, or (b) delete the event bus from v1 and document "side-effects run via reconcilers only." Do not ship code that pretends to dispatch and doesn't.

### C2. Certificate verification codes use `Math.random()`

**Evidence.** `src/engine/certificates.ts:45-53`:

```ts
function generateVerificationCode(): string {
    const alpha = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    let out = "";
    for (let i = 0; i < 12; i++) {
        const r = Math.floor(Math.random() * alpha.length);
        out += alpha[r];
    }
    return out;
}
```

**Why it matters.** Verification codes are the *only* authenticator on the public `certificate:verify` route (`src/routes/public-certificates.ts:37-49`). They are printed onto certificates and meant to prove issuance to third-party verifiers. `Math.random()` is a non-cryptographic PRNG (V8 uses an xorshift128+ variant); observing a small number of emitted codes is typically sufficient to recover state and predict subsequent codes. Combined with the public-endpoint rate limit of 30/min/IP (`DEFAULT_VERIFY_RATE_LIMIT`), an attacker who can read a handful of legitimately-issued codes can enumerate or forge future ones. This also devalues every cert already issued.

The rate limit itself is non-atomic (see H6 below), so the 30/min ceiling is approximate.

**Fix.** Replace with `crypto.getRandomValues` (available on Node 19+, Workers, and every supported runtime):

```ts
const bytes = new Uint8Array(12);
crypto.getRandomValues(bytes);
for (let i = 0; i < 12; i++) out += alpha[bytes[i] % alpha.length];
```

Mind the modulo bias (32 divides 256 cleanly, so for this 32-char alphabet it's fine; do not copy the pattern to a 36-char alphabet without rejection sampling).

### C3. Every curriculum read and every progress write scans the full lessons + topics collections

**Evidence.** `src/engine/curriculum.ts:86-135` and `src/engine/progress.ts:103-170` define four functions — `listLessonsForCourse`, `listTopicsForCourse`, `listPublishedTopicsForCourse`, `listPublishedTopicsForLesson` — all with the same shape:

```ts
async function listLessonsForCourse(ctx, courseId) {
    let cursor;
    do {
        const page = await ctx.content.list("lessons", { where: { status: "published" }, limit: 100, cursor });
        for (const lesson of page.items) {
            if (lesson.data["course"] === courseId) matches.push(...);
        }
        cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
}
```

The `where` filter can only match `status`; the course filter is applied client-side. This is acknowledged in route comments (`src/routes/public-catalog.ts:14-17`, `src/routes/instructor-lessons.ts:13-16`).

**Call sites (non-exhaustive):**
- `curriculum.forUser` (line 175) → calls both list functions. Invoked by `curriculum` route, `lesson` route, `topic` route, `my-learning` route, `drip-release-reminders` reconciler (per enrollment, per cron tick).
- `progress.tick` (line 248) → `resolveStep` + `markStepComplete` when ≥90%. `markStepComplete` → `markLessonCompleteInternal` → `listPublishedTopicsForLesson` (full topics scan) → `evaluateCourseComplete` → `listPublishedLessonsForCourse` + `listPublishedTopicsForCourse` (two more full scans).
- `progress.markStepComplete` (line 322) — any explicit completion.
- `hooks/content.contentBeforeDelete` — on deleting a course, `hasContentReferencingCourse` scans both collections.
- `engine/analytics.countContentInCourse` — every analytics call that needs totals.

**Why it matters.** Per `progress:tick` in a non-trivial install (e.g. 50 courses × 20 lessons × 5 topics = 1k lessons and 5k topics), a single tick that crosses the auto-complete threshold transfers on the order of 6k content rows across subrequests, plus per-topic `step_progress.get`+`put` writes. Players call `progress:tick` every ~15 s per `src/routes/student-progress.ts:120`. On Cloudflare Workers, this blows past the 1,000-subrequest paid-plan limit for a single completion. On Node + SQLite, each tick is a multi-second query burst under contention.

The `curriculum` read — which powers the course detail page load — has the same footprint. Students opening a single lesson on a real deployment will trigger two full collection scans.

Documented mitigations are absent: `src/engine/curriculum.ts:95-105` has `oxlint-disable no-await-in-loop` but no caching. The `MAX_SCAN = 10_000` in analytics (`src/engine/analytics.ts:134`) is a safety cap, not a perf solution, and does not protect the curriculum / progress paths.

**Fix.** Either (a) extend emdash's `content.list` to support reference-field filters server-side, or (b) in the plugin, maintain a denormalized `(courseId, lessonId, topicId)` projection in plugin storage that is updated from `content:afterSave` / `content:afterDelete` hooks and is the source of truth for curriculum reads. Either way, the v1 data flow cannot ship with full scans on every tick.

### C4. `plugin:uninstall` with `deleteData=true` silently fails to drop content collections

**Evidence.** `src/sandbox-entry.ts:171-186`:

```ts
const dropCollection = async (slug) => {
    try {
        const res = await fetch(
            ctx.url(`/_emdash/api/schema/collections/${encodeURIComponent(slug)}?force=true`),
            { method: "DELETE" },
        );
        if (!res.ok && res.status !== 404) {
            ctx.log.warn(`Failed to drop collection ${slug}: ${res.status}`);
        }
    } catch (err) { ... }
};
```

Per emdash, `/_emdash/api/schema/*` requires the `schema:manage` permission at `packages/core/src/astro/routes/api/schema/collections/[slug]/index.ts` (see sub-agent investigation against `/Users/baezor/dev/emdash`). The uninstall hook runs in the plugin's server context with no browser cookies and no admin token — so this `fetch` goes out unauthenticated, receives 401/403, logs a warning, and exits successfully.

The plugin storage (`enrollments`, `step_progress`, `certificates`, etc.) is dropped by emdash core, per the comment on line 167. But the **authored courses, lessons, and topics** persist. An admin expecting "delete data" to remove everything finds their Courses collection intact on reinstall.

**Why it matters.** This is a data-deletion correctness issue, and for any operator with GDPR obligations it is a compliance issue: the admin asked for data to be deleted, the plugin silently kept it. The log warning is easy to miss.

**Fix.** Either (a) have emdash expose an in-process schema API to the plugin context, (b) require the admin UI to call a dedicated uninstall endpoint in the browser session so cookies ride along, or (c) surface the failure loudly (throw from the hook so emdash marks uninstall as failed) and document that collection drop requires manual action. Do not pretend the collections are gone when they aren't.

### C5. `plugin:install` does not provision the collections the engine depends on

**Evidence.** `src/sandbox-entry.ts:151-159` — the install hook only seeds default settings and stamps the bootstrap KV record. Collection provisioning lives entirely in `src/admin/SetupWizardPage.tsx`, which runs `core-schema-client` calls from the **admin browser**. Until that wizard runs, `ctx.content.get("courses", …)`, `ctx.content.list("lessons", …)`, etc., return null / empty.

The only hints the user gets are the README line "open the one-click setup wizard at `/_emdash/admin/plugins/lms-core/setup`" and the `setup:state` route returning `version: 0`. If the user follows the README's "Install / Quick start" and visits `/catalog` without running the wizard, the `catalog` route's `ctx.content.list` fails (returns nothing) and the student gets a "No published courses yet" page even though enrollment routes also fail (no course rows).

This collides directly with `docs/emdash-issues-from-t28.md` issue #1: the admin pages the wizard lives on are currently unreachable through `usePluginPage` in the sibling emdash repo, because the plugin registers dynamic routes like `/courses/:courseId` which fall back to `SandboxedPluginPage` and 404. The wizard itself is reachable (it's on `/setup`, no params), but the docs note admin UI testing is blocked.

**Why it matters.** "Install and it works" is the headline contract of a v1 plugin. Today installation is a two-step dance: `pnpm add` + register in `astro.config` + admin opens wizard + admin clicks through. A v1 ship should either do the provisioning in the install hook (as far as the platform permits) or be crystal clear in the README that `pnpm add` alone does nothing.

**Fix.** Provision via an emdash-facing API that the install hook can call directly (see C4 — same root cause: no in-process schema API for plugins). Or: gate every route handler on `BootstrapState.version >= BOOTSTRAP_VERSION` and return `LEARN_SETUP_INCOMPLETE` with a structured "run the wizard at ..." payload instead of silently returning empty results.

---

## High — should fix before v1

### H1. `quiz:start` has no enrollment check; quiz content leaks to any logged-in user

**Evidence.** `src/engine/quizzes.ts:337-365` (`startAttempt`) performs no enrollment or course check. `src/routes/quizzes.ts:144-153` (`startRoute`) only gates on `requireRole(SUBSCRIBER)`:

```ts
const startRoute: PluginRoute<QuizStartInput> = {
    input: quizStartInput,
    handler: async (ctx) => {
        const user = gateStudent(ctx);
        const result = unwrap(
            await quizzes.startAttempt(ctx, user.id, ctx.input.quizId, ctx.input.lessonId),
        );
        return result;
    },
};
```

A subscriber can POST `{ quizId }` for any quiz id they discover and receive the full `questions` payload (stripped of `correct` and `explanation`, but prompts and options are included). For a paid course whose value is the quiz content, that's a leak.

**Fix.** Quizzes should be attachable to a lesson (via Portable Text block id, or a `quiz.lessonId` field), and `startAttempt` should require the caller be actively enrolled in the lesson's parent course. If a quiz isn't attached to any lesson, it can be public (like an unsecured assessment) — make that explicit with a `public: boolean` field, not an accident.

### H2. `quiz:submit` auto-completes any lesson id the client sent at `quiz:start`

**Evidence.** `src/engine/quizzes.ts:337-365` — `startAttempt` accepts `lessonId?` and stores it on the attempt row verbatim. `src/engine/quizzes.ts:429-442`:

```ts
if (persistedPassed && attempt.lessonId) {
    const completed = await markStepComplete(ctx, attempt.userId, "lesson", attempt.lessonId);
    ...
}
```

`markStepComplete` does validate enrollment and step existence, but **does not verify the quiz is actually attached to `attempt.lessonId`.** A malicious client calling `quiz:start` can submit `{ quizId: <easy_public_quiz>, lessonId: <hard_gated_lesson_in_same_course> }`, pass the easy quiz, and have the hard lesson marked complete. (The topics-complete gate on `markLessonCompleteInternal` still applies, but the lesson *body* is auto-completed.)

**Fix.** `startAttempt` should resolve `lessonId` → lesson and verify the lesson's Portable Text body contains the quiz block referencing `quizId`, or use a first-class `lesson.quizId` schema field. Without that, drop the `lessonId` parameter and require explicit `progress:complete` calls.

### H3. `enrollments.grant` race turns duplicate into a 500

**Evidence.** `src/engine/enrollments.ts:199-223`:

```ts
const existing = await findEnrollment(ctx, userId, input.courseId);
if (existing && !existing.data.revokedAt) {
    return err(LEARN_ERRORS.ALREADY_ENROLLED, ...);
}
...
const id = existing?.id ?? `enr_${ulid()}`;
...
await enrollmentsStore(ctx).put(id, data);
```

Two concurrent `enroll` requests both see `existing == null`, both generate a fresh `enr_${ulid()}` id, both `put`. Storage put is keyed on `(plugin_id, collection, storage_id)` (per emdash's `_plugin_storage` schema) — different storage ids, so the PK upsert succeeds for both. The **unique index** on `(userId, courseId)` (declared in `src/sandbox-entry.ts:97` as `uniqueIndexes: [["userId", "courseId"]]`) fires a SQLite UNIQUE violation on the second insert. The engine has no try/catch; the throw bubbles as `INTERNAL_ERROR` to the client.

A user double-clicking "Enroll" (or a flaky network retrying) gets a 500 instead of the intended idempotent `LEARN_ALREADY_ENROLLED`.

**Fix.** Wrap the `.put` in a try/catch and, on unique-violation, re-query and return `LEARN_ALREADY_ENROLLED` (or, if `existing.revokedAt`, refresh it). Better: expose a CAS/insertIfNotExists primitive on emdash storage.

The same shape exists in `src/engine/cohorts.ts:142-188` (addMember), and is documented as acceptable there ("D43: 1–2 overage tolerated"). The enrollment case is not equivalent — the UX surface is a user-facing button, not an admin import.

### H4. Welcome / completion emails never send in production

Covered by C1. Repeating here because the student-facing impact deserves "high" emphasis: no one who enrols in a course gets a confirmation email (there is no event handler), no one who completes a course gets a congratulations or their verification code by email, and no instructor gets "a student just enrolled in your course" — unless an operator adds those handlers after install, which nothing in the plugin tells them to do.

### H5. Comment-gate hook fails **open** when `ctx.content` is missing

**Evidence.** `src/hooks/comment.ts:59-64`:

```ts
// Without content access we can't resolve the lesson's parent course,
// so allow — emdash will still enforce its own collection-level gates.
if (!ctx.content) return;
const lesson = await ctx.content.get(LESSONS_COLLECTION_SLUG, event.comment.contentId);
const courseId = (lesson?.data as Record<string, unknown> | undefined)?.["course"] as string | undefined;
if (!courseId) return;
```

A gate that admits everyone when its dependency is unavailable is the wrong direction. If `ctx.content` isn't wired (capability mis-grant, emdash regression, an edge case during install), every lesson comment sails through regardless of `commentGateRequiresEnrollment`.

**Fix.** When the gate is enabled (`commentGateRequiresEnrollment === true`) and the check cannot be performed, refuse. Log the reason so an operator can see why.

### H6. Public certificate-verify rate limit is non-atomic

**Evidence.** `src/engine/certificates.ts:241-252`:

```ts
const current = (await ctx.kv.get<number>(key)) ?? 0;
if (current >= opts.maxPerBucket) { return err(...); }
await ctx.kv.set(key, current + 1);
```

Read-then-write. Concurrent requests can both see `current < max` and both write `current+1`, so the effective limit under concurrency is higher than configured. This is not a denial-of-service gate for the plugin itself — it's the only barrier to brute-forcing the 32^12 codespace plus whatever bias Math.random injects (C2). Combined with C2, the rate limit should be tight and predictable.

**Fix.** Use an atomic KV increment if emdash exposes one; otherwise pair this with a short-term Durable Object / SQLite-backed counter. At minimum, switch to a token-bucket keyed on `(ip, minute)` with a strictly monotonic counter.

### H7. `SetupWizardPage.runStep` has no pre-auth guard

**Evidence.** `src/admin/SetupWizardPage.tsx:114-148`. The "Apply" button makes unauthenticated-looking `POST /_emdash/api/schema/collections` calls that emdash rejects with 403 if the viewer is not admin. The UI then surfaces `"schema POST /collections failed: 403"` — cryptic to operators who are not intimate with the emdash permission model.

Minor risk, but a first-install user experience problem.

**Fix.** On mount, call a `whoami`-style route (or inspect `ctx.user.role` exposed by any admin-gated plugin route, e.g. `admin:settings:get`) and show a "you must be admin to run setup" state instead of letting apply fail.

### H8. `plugin:uninstall` runs the collection drop in reverse but skips the `plugin storage` deletion confirmation

Covered by C4. Additional note: if emdash's storage-drop fails for any reason, the plugin has no way to know — there is no `plugin:uninstall` return channel for success/failure of the platform side. For a v1 that advertises data-lifecycle correctness, this deserves documentation.

---

## Medium — fix soon after v1

### M1. True/false grading matches option text against `/^true$/i` and `/^false$/i`

**Evidence.** `src/engine/quizzes.ts:95-105`. If a quiz author ships a `true_false` question with options labelled "Vrai" / "Faux", "Yes" / "No", or "Correct" / "Incorrect", `gradeTrueFalse` can't identify the truthy option — a boolean answer from the client maps to `undefined` and grading silently scores zero.

The plugin's README and CHANGELOG claim "i18n" support for the topics primitive. A user translating quiz UI would very reasonably translate the option labels too, and grading would stop working without any error.

**Fix.** Either require `true_false` options to be identified by `id` rather than text (`options: [{id: "true", correct: true}, {id: "false", correct: false}]`), or let the author pick which option is the "true" branch during authoring.

### M2. `step_progress` has no unique index on `(userId, stepType, stepId)`

**Evidence.** `src/sandbox-entry.ts:98-108`:

```ts
step_progress: {
    indexes: [
        "userId", "courseId", "stepId", "stepType",
        ["userId", "courseId"], ["userId", "courseId", "stepType"],
        "completedAt",
    ],
},
```

No `uniqueIndexes`. The engine relies on `progressId(userId, stepType, stepId)` (`src/engine/progress.ts:57-59`) as a deterministic storage id to guarantee at-most-one row. Any future code path that creates a step_progress row with a different id shape (e.g. `prog_${ulid()}`) would create a duplicate that nothing catches.

**Fix.** Add `uniqueIndexes: [["userId", "stepType", "stepId"]]`. The storage layer will enforce what the id convention implies.

### M3. Public catalog search paginates incoherently

**Evidence.** `src/routes/public-catalog.ts:154-163`. `content.list` returns a raw page (upstream cursor, upstream hasMore), the route filters by `difficulty` and `search` after pagination. When a user sends `search=python`, the response contains **only the matches on the first page of "published" rows**. The `hasMore` flag reflects the upstream page, so the client may happily request the next cursor only to get more unfiltered rows → the client's UX either shows empty pages or drops matches.

**Fix.** Accumulate pages server-side until the filtered-result limit is met (with a safety cap). Return a synthetic cursor. Eventually push the filter into `content.list` via a proper text index.

### M4. `cohort:import` silently drops capacity failures

**Evidence.** `src/engine/cohorts.ts:221-269`. If `addMember` returns `LEARN_COHORT_AT_CAPACITY` mid-loop, the email is not added to `added`, not added to `unknownEmails`, and not added to `alreadyMembers`. The caller sees `counts.added < emails.length` but has no list of which rows failed capacity.

For an instructor running a 500-row CSV import, this is operationally painful.

**Fix.** Add `capacityRejected: string[]` (or `rejected: Array<{email, code}>`) to the import result.

### M5. `engine/analytics.ts` is entirely "scan and count" with no caching

**Evidence.** `src/engine/analytics.ts:134` (`MAX_SCAN = 10_000`), and every dashboard/instructor/admin analytics route scans `enrollments`, `step_progress`, and/or `quiz_attempts` from scratch. `admin:analytics-overview`, `admin:courses-comparison`, `admin:engagement-metrics` scan the entire plugin storage on every call.

Acknowledged as v1 ("scan and count" in line 10 comment). Worth flagging that two or three concurrent admins opening the dashboard will concurrently pull every row in every collection. Add a per-request memoization at minimum; better, cache per-bucket counters in KV with TTL.

### M6. `node:crypto` import in `engine/email-queue.ts` forces `nodejs_compat` on Workers

**Evidence.** `src/engine/email-queue.ts:23` imports `randomUUID` from `node:crypto`. `crypto.randomUUID()` is globally available on Workers without compat flags and on Node 19+. The README advertises Cloudflare Workers support (CHANGELOG 0.1.0 "Node 20+ or Cloudflare Workers") but does not tell operators they need `compatibility_flags = ["nodejs_compat"]` in `wrangler.toml`.

**Fix.** Use `globalThis.crypto.randomUUID()`. Removes a deployment footgun and drops a dependency on the node compat surface.

### M7. Version identity will drift between `package.json`, `PLUGIN_VERSION`, and the CHANGELOG on first publish

**Evidence.**
- `src/constants.ts:8`: `PLUGIN_VERSION = "0.0.0"`
- `package.json:3`: `"version": "0.0.0"`
- `CHANGELOG.md:7`: `## 0.1.0 — 2026-04-18`
- `.changeset/initial-release.md:2`: `"@emdashlms/plugin": major`

When `pnpm changeset version` runs, changeset bumps `package.json` from `0.0.0` to `1.0.0` (major). It does not edit `src/constants.ts`. The CHANGELOG section it writes will say `1.0.0`, but a hand-written `## 0.1.0` entry already exists in the file. So at publish, `package.json === 1.0.0`, `PLUGIN_VERSION === "0.0.0"`, and the CHANGELOG has a `0.1.0` block that was never a real release.

**Fix.** Decide the target version (recommendation: `1.0.0` on initial release, making the surface below a known break), delete the stub `0.1.0` CHANGELOG entry, and either (a) keep `PLUGIN_VERSION` read from `package.json` at build time (tsdown can inline) or (b) replace the constant with a code-generated import from the manifest.

### M8. `quiz:submit` rejects an empty answer list at the Zod layer

**Evidence.** `src/routes/quizzes.ts:85-94`: `answers: z.array(...).min(1)`. If the student submits with no answers filled in (all-unanswered), the request is 400'd before grading. The engine's `grade` handles "no answer for question X" cleanly as wrong. The Zod gate denies that valid UX.

**Fix.** Change `.min(1)` to `.min(0)`. Treat empty-answer submissions as "scored as zero," not as malformed requests.

### M9. Verify route leaks "revoked code exists" state

**Evidence.** `src/engine/certificates.ts:187-192` — `verify` returns `valid: false` with `revokedAt`, `expiresAt`, `userName`, and `courseTitle` populated when the row exists. A brute-forcer can distinguish "this code exists and is revoked" from "no such code." Combined with C2, this is another gadget — revoked codes become an enumeration oracle.

**Fix.** When `!valid`, return `{ valid: false }` with no metadata. Accept the slightly worse UX (users with a revoked cert don't see a helpful "revoked on date X" message); they can contact support instead.

### M10. Admin settings KV writes bypass read-time type validation

**Evidence.** `src/routes/admin-settings.ts:154-161` writes the Zod-validated patch straight through to KV. `readSettings` (line 112-120) falls back to `DEFAULT_SETTINGS[name]` only on `null`, not on type-mismatch. An older install that wrote a different shape (e.g. `dripMode` as a number from a pre-v1 iteration) surfaces that stored shape to `getDripMode()` (`src/engine/curriculum.ts:67-70`) which coerces anything non-"relative" to "immediate" silently.

**Fix.** In `readSettings`, validate each stored value against the schema and overwrite + warn on drift.

### M11. `Math.random()` also used for quiz question option ids in the admin editor

**Evidence.** `src/admin/QuizEditPage.tsx:74`:

```ts
return `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
```

Low-severity — these ids are author-scoped and not secret. But a v1 that also uses `Math.random` in the certificate path (C2) should at least standardize on `crypto.randomUUID()` for ids to avoid the pattern reappearing.

---

## Low — worth knowing, not worth blocking on

### L1. No SECURITY.md, no security-reporting email

**Evidence.** `CONTRIBUTING.md:14` says "email the maintainers" but provides no address. `.github/` contains only `workflows/`. No `SECURITY.md`, no `CODE_OF_CONDUCT.md` (despite `CONTRIBUTING.md:79-81` referencing the Contributor Covenant), no issue templates, no PR template.

### L2. Demo site ships hardcoded dev-bypass auth links in production HTML

**Evidence.** `demos/simple/src/pages/my-learning.astro:98-105`. If an operator `git clone`s and deploys the demo without changes, the page links to `/_emdash/api/auth/dev-bypass?asUser=alice@student.local` for anyone who visits it. The dev-bypass endpoint is (per the docs file) meant for local dev, but the page renders those links regardless of env.

Add a guard: `import.meta.env.DEV` or equivalent, and a clear "DO NOT DEPLOY AS-IS" in the demo README.

### L3. `pnpm.overrides` in `package.json` links against a sibling repo

**Evidence.** `package.json:92-94`:

```json
"pnpm": { "overrides": { "emdash": "link:../emdash/packages/core" } }
```

This is a dev convenience. It ships in the published package.json and will confuse anyone who installs the package and wonders why the peer dep `emdash` is being overridden to a path. Most package managers will ignore the override silently in a consumer project, but it is a wart.

**Fix.** Strip `pnpm.overrides` from the published manifest via a prepublish step, or move the override into `pnpm-workspace.yaml`.

### L4. Large planning / reference markdown files at repo root

`prd-plugin.md` (142 KB), `prompt-topics-refactor.md` (15 KB), `emdash-learn-viability.md` (8.4 KB) live next to `README.md`. These bulk up `npm pack`'d payloads (the `files: ["dist","src"]` in package.json saves us on publish — only `dist` and `src` ship, good) but they still clutter the repo for new contributors. Move to `docs/internal/`.

### L5. Admin pages are inline-styled

`src/admin/SetupWizardPage.tsx` and the other admin pages use React + inline style objects. Comments acknowledge this is deferred to a Kumo/Lingui refactor (`SetupWizardPage.tsx:10-12`). Documented explicitly in the CHANGELOG as admin UI shipping; reality is visible "unfinished" polish. Contrast / focus ring / keyboard nav were not reviewed in depth but inline colours like `#94a3b8` on white (disabled primary button) and `#854d0e` on `#fefce8` (warning banner) are near WCAG 4.5:1.

### L6. No per-plugin-UI i18n catalog

The README claims i18n readiness; the plugin itself has every admin string hard-coded in English. i18n in the README refers to content-item translation (delivered by emdash). Worth clarifying the distinction.

### L7. Weak or missing integration coverage for the CSRF / session contract

`tests/utils/test-plugin-ctx.ts` stubs out `email`, `log`, `http`. It exercises engine and hook behaviour against a real SQLite, which is excellent. But the route surface (CSRF header, session cookie, `{success, data}` envelope handling) is not integration-tested against emdash's real HTTP dispatcher. `tests/integration/routes/` has three files (analytics, instructor-lessons, public-catalog). Auth-gated routes are not end-to-end asserted. If emdash changes its envelope shape (e.g. to `{ data, meta }`), the api-client / demo `lms-api.ts` helpers silently break.

### L8. LICENSE copyright year 2026

`LICENSE:3`: "Copyright (c) 2026 Emdash Learn contributors". Accurate today; will be correct for initial release. Not a bug. Noting because people commonly flag year-from-future as fraud; not an issue here.

### L9. Several `any` casts to reach emdash's content surface

`src/routes/instructor-lessons.ts:73`, `src/routes/instructor-topics.ts:138`, `:256`. All documented with `-- emdash content surface` comments. Indicates the plugin-facing content write API is not cleanly typed in emdash yet (upstream follow-up mentioned elsewhere).

---

## Suspicions (not verified)

### S1. Cold-start bundle size on Workers may be larger than needed

`src/admin.tsx` eagerly imports all 11 admin React components. `tsdown.config.ts` ships `src/admin.tsx` as the `./admin` entry, with React/ReactDOM marked external. I did not measure the built bundle or check whether the admin entry is loaded in the student-facing request path. If `sandbox-entry.ts` pulls anything that transitively imports the admin tree, a curriculum read would pay the React hydration cost. **To confirm:** `pnpm build && ls -la dist/` and check whether `sandbox-entry.mjs` includes any React symbols.

### S2. Quiz time-limit policy is enforced by the engine, but nothing stops a client from posting `submittedAt` in the past

Not directly relevant — the engine computes `elapsedSeconds` from `attempt.startedAt` (server-stamped) to `now` (server clock). Verified by reading `src/engine/quizzes.ts:130-138`. Safe.

### S3. Emdash's plugin-route dispatcher wraps the handler return in `{ success: true, data }`

The api-client (`src/admin/api-client.ts:397-399`) and `demos/simple/src/lib/lms-api.ts:30-34` both expect `{ data }` in the success envelope. The sub-agent investigation confirmed the emdash source uses `apiSuccess` with `{ data: T }`. If emdash regresses to a raw return or `{ success, data }`, both clients break. Worth a contract test.

### S4. Drip-release reminders call `curriculum.forUser` per enrollment per cron tick

`src/reconcilers/drip-release-reminders.ts:45`. Every active enrollment + every cron tick = one full curriculum scan per enrollment, see C3. For 10k enrollments and the documented hourly cadence, that is 10k × 2 full content scans per hour. **Would confirm** by counting calls in a load test.

### S5. `ctx.user` on plugin route handlers is `UserInfo | null`

The plugin routes cast `ctx as unknown as AuthContext` (`src/routes/student-progress.ts:126`) assuming the emdash route context has `user`. The sub-agent confirmed this, but it's a cast, not a type-safe guarantee. If emdash ever renames `user` to `session.user`, the plugin compiles and all routes treat everyone as unauthenticated. Add a runtime assertion or contract test.

---

## Out of scope (deliberately not audited)

- **Behavioural execution**: nothing was run. All findings are static.
- **Bundle analysis**: I did not measure `dist/` output size, cold-start time, or import graphs.
- **Upstream emdash bugs**: Issue #1 in `docs/emdash-issues-from-t28.md` (the `usePluginPage` param-route regression) is an emdash bug, not an lms-core bug, and the `docs/` file already drafts the fix.
- **Full admin UI review**: `CoursePage.tsx` (53 KB), `QuizEditPage.tsx` (34 KB), `CohortDetailPage.tsx` (22 KB), `StudentProgressPage.tsx` (14 KB) were skimmed for fetch / CSRF patterns but not exhaustively reviewed for UX or a11y.
- **E2E flows**: I read the `quiz-taking.spec.ts` but did not trace the other four Playwright specs.
- **Seed script / demo data**: `demos/simple/scripts/seed-lms.ts` (28 KB) was not opened. A seed script is not shipped.
- **`ctx.http` usage**: I grep'd and found none in `src/` — no outbound HTTP from the plugin runtime, only from the admin browser via `core-schema-client`. Not separately reviewed for SSRF because there is no surface for it.
- **PRD conformance**: `prd-plugin.md` is 142 KB of requirements. I did not cross-check every claim in it against code.

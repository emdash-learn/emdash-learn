# v1 subagent dispatch plan

Self-contained playbook for dispatching the v1 fix work to subagents. A clean Claude session can run this file end-to-end without needing the original audit conversation.

**Read order for the orchestrator:**
1. `AUDIT.md` — the findings (evidence + severity)
2. `docs/v1-decisions.md` — the three design-gate rulings (A, B, C)
3. This file — per-track specs + ready-to-paste agent prompts

**Assumptions you are operating under:**
- Base branch is `develop`. Main branch is `main`.
- Every subagent runs under `isolation: "worktree"` so parallel tracks don't step on each other.
- Subagent type is `general-purpose` unless noted (it has Edit/Write; Explore does not).
- Every subagent auto-loads `CLAUDE.md` — they'll pick up sibling-emdash layout notes.
- Subagents do **not** open PRs, merge, or push. They report back with a branch name + summary.
- After each agent reports, run `superpowers:code-reviewer` against its branch before merging.

---

## Dispatch procedure

**Wave 1 (6 tracks, parallel).** Dispatch all six in a single message with multiple `Agent` tool uses. No gates block Wave 1.

**Wave 2 (3 tracks, staged).**
1. Dispatch **Track D** first (solo). It owns `sandbox-entry.ts` for the wave.
2. After D merges, dispatch **Track C** and **Track F** in parallel.
3. After D merges, dispatch **Track J** (rebases on D's projection).

**Wave 3 (verification).** Dispatch after all Wave 2 branches merge. Single agent.

**Before dispatching Wave 2:** confirm `docs/v1-decisions.md` `Decision:` lines match what the prompts below assume (Gate A: Rip, Gate B: Document, Gate C: Projection in-plugin). If any gate flipped, the affected track's prompt needs a rewrite — stop and ask.

---

## Wave 1 — dispatch now

### Track A · Credential hardening · AUDIT C2, H6, M9

| | |
|---|---|
| Branch | `fix/cert-credentialing` |
| Gate | None |
| Depends on | Nothing |
| Touches | `src/engine/certificates.ts`, `tests/integration/engine/certificates.test.ts`, `tests/unit/engine/` (new file if needed) |
| Off-limits | Everything else |

**Agent call:**
- `description`: "Fix cert credentialing"
- `subagent_type`: `general-purpose`
- `isolation`: `worktree`

**Prompt:**

```
You are a senior engineer fixing audit findings in @emdash/lms-core, an LMS plugin
for emdash. Read AUDIT.md sections C2, H6, M9 first, then CLAUDE.md for repo
conventions.

Mission: harden certificate credentialing.

Files you may edit:
- src/engine/certificates.ts
- tests/integration/engine/certificates.test.ts
- new file under tests/unit/engine/ if useful

Do not touch any other file. If a dependent change looks required elsewhere,
stop and report — do not modify.

Changes:

1. src/engine/certificates.ts:45-53 — replace Math.random() in
   generateVerificationCode with crypto.getRandomValues(new Uint8Array(12)).
   Use rejection sampling (32-char alphabet divides 256 cleanly, so simple
   modulo is fine; document the invariant with a short comment). Keep the
   12-char length and Crockford alphabet.

2. src/engine/certificates.ts:236-253 — checkVerifyRateLimit is non-atomic.
   Either (a) back the counter with plugin storage (new collection, you decide
   the name, with a unique index on [ip, bucket]) and an atomic upsert-with-
   increment, or (b) keep KV but reimplement with a best-effort CAS pattern.
   Prefer (a) for correctness. Declare the new storage collection in
   src/sandbox-entry.ts — this is the only edit you make outside certificates.ts
   (add a single collection entry to the storage block, nothing else).

3. src/engine/certificates.ts verify — when valid === false, return
   { valid: false } with no other fields. Tighten VerificationResult to a
   discriminated union { valid: true; issuedAt: string; ... } | { valid: false }.
   Update the one caller in src/routes/public-certificates.ts if the type
   change requires it (minimal edit).

Acceptance:
- pnpm typecheck passes
- pnpm lint:quick passes
- pnpm test passes
- New unit test: generate 10_000 codes, assert Shannon entropy > 4.9 bits/char
- New integration test: 50 concurrent verify calls at the limit boundary;
  successes <= maxPerBucket exactly
- New integration test: invalid code returns { valid: false } with zero other
  keys (use Object.keys(result).length === 1)
- rg 'Math\.random' src/engine/certificates.ts returns zero matches

Branch off develop: fix/cert-credentialing. Imperative commit messages per
CONTRIBUTING.md. Reference "Fixes AUDIT C2, H6, M9" in the body of your final
commit.

Report back with: branch name, file list touched, test output summary,
any blockers. Do not open a PR.
```

---

### Track B · Quiz correctness · AUDIT H1, H2, M1, M8

| | |
|---|---|
| Branch | `fix/quiz-correctness` |
| Gate | None (implementation is self-contained; schema fixture change is additive) |
| Depends on | Nothing |
| Touches | `src/engine/quizzes.ts`, `src/routes/quizzes.ts`, `src/setup/schema-fixtures.ts`, `src/types/content.ts`, `src/types/storage.ts`, `tests/unit/engine/quizzes-grade.test.ts`, `tests/integration/engine/quizzes.test.ts` |
| Off-limits | Everything else |

**Prompt:**

```
You are a senior engineer fixing audit findings in @emdash/lms-core. Read
AUDIT.md sections H1, H2, M1, M8 and CLAUDE.md.

Mission: close four quiz correctness gaps.

Files you may edit:
- src/engine/quizzes.ts
- src/routes/quizzes.ts
- src/setup/schema-fixtures.ts    (add a lesson-level `quiz` reference field)
- src/types/content.ts            (add quizId?: string to LessonRow)
- tests/unit/engine/quizzes-grade.test.ts
- tests/integration/engine/quizzes.test.ts
- new files under tests/integration/routes/ if useful

Do not touch any other file.

Changes:

1. H1 — enrollment gate on quiz:start.
   src/engine/quizzes.ts:startAttempt now requires a lessonId. Resolve
   lesson -> course via ctx.content.get, call engine/enrollments.isEnrolled,
   refuse with LEARN_NOT_ENROLLED otherwise. Update the Zod schema in
   src/routes/quizzes.ts to mark lessonId required (.min(1), not optional).

2. H2 — attachment check on quiz:start.
   The resolved lesson MUST have its `quiz` field equal to the incoming
   quizId. Add the `quiz` field spec to src/setup/schema-fixtures.ts
   lessonsFields (type "string", not locked, optional). Add quizId?: string
   to LessonRow. On mismatch, refuse with LEARN_FORBIDDEN "quiz not attached
   to this lesson". The auto-complete branch in submitAttempt can then trust
   attempt.lessonId without re-checking.

3. M1 — true/false grading by id, not text.
   src/engine/quizzes.ts:gradeTrueFalse currently finds the "true" option by
   /^true$/i.test(text). Replace: the authored quiz must mark the correct
   option via options[].correct (already the case). Simplify to "client sent
   optionId matches correct option's id" — same pattern as gradeMcq. Localized
   option labels stop breaking grading.

4. M8 — allow empty answer lists.
   src/routes/quizzes.ts:84-95 — change `.min(1)` to `.min(0)` on quizSubmitInput.answers.
   The engine already scores missing answers as wrong.

Acceptance:
- pnpm typecheck, lint:quick, test all pass.
- Existing quizzes-grade.test.ts cases still pass (you may tweak true/false
  fixture assertions to match id-based matching).
- New test: subscriber A tries quiz:start for a quiz attached to a course
  they're not enrolled in -> LEARN_NOT_ENROLLED.
- New test: subscriber enrolled in course X calls quiz:start with quizId of
  a quiz in course Y, lessonId of a lesson in course X -> LEARN_FORBIDDEN.
- New test: submitting an empty answers array grades 0 and returns passed=false
  without a 400.
- New test: true_false option labeled "Vrai"/"Faux" grades correctly.

Branch off develop: fix/quiz-correctness. Reference "Fixes AUDIT H1, H2, M1, M8".

Report back with the acceptance checklist results and any upstream concerns
(e.g. if adding the `quiz` field requires a BOOTSTRAP_VERSION bump — flag it,
do not bump the version yourself in this track; Track I owns version hygiene).
```

---

### Track E · Enrollment race + comment gate · AUDIT H3, H5

| | |
|---|---|
| Branch | `fix/enrollment-race-comment-gate` |
| Gate | None |
| Depends on | Nothing |
| Touches | `src/engine/enrollments.ts`, `src/hooks/comment.ts`, matching tests |
| Off-limits | Everything else |

**Prompt:**

```
Senior engineer, @emdash/lms-core. Read AUDIT.md sections H3, H5 and CLAUDE.md.

Mission: two small correctness fixes.

Files you may edit:
- src/engine/enrollments.ts
- src/hooks/comment.ts
- tests/integration/engine/enrollments.test.ts
- tests/integration/hooks/comment.test.ts

Do not touch any other file.

Changes:

1. H3 — enrollments.grant race.
   src/engine/enrollments.ts:199-223. Two concurrent grants with null `existing`
   race, both put with different storage ids, the unique (userId,courseId) index
   throws on the second write, bubbling as INTERNAL_ERROR. Wrap the
   enrollmentsStore.put call in try/catch. On failure, re-query findEnrollment;
   if a row now exists, return LEARN_ALREADY_ENROLLED (or, if existing.revokedAt,
   refresh into the un-revoked shape and return ok). Use a narrow error check —
   match on SQLite UNIQUE keyword or emdash's error code if exposed; fall back
   to "re-query, check, decide" so it stays robust if emdash changes error shape.

2. H5 — comment gate fail-open.
   src/hooks/comment.ts:59-64 currently allows the comment when ctx.content is
   missing. When the gate setting is ON, absence of content access means we
   cannot enforce — refuse (return false) and log.warn. Only fail-open when
   the gate is OFF. Walk the function's decision tree and fix accordingly.

Acceptance:
- pnpm typecheck, lint:quick, test all pass.
- New race test: 10 concurrent grant calls for the same (user, course) — exactly
  one resolves to ok, the rest to LEARN_ALREADY_ENROLLED, zero to anything else.
- New test: commentGateRequiresEnrollment=true, ctx.content absent, authorUserId
  present, comment on lessons collection -> returns false (refuse) and emits a
  warn log.
- Existing tests still pass.

Branch off develop: fix/enrollment-race-comment-gate. Reference "Fixes AUDIT H3, H5".

Report back.
```

---

### Track G · Public-surface hygiene · AUDIT M3, M10

| | |
|---|---|
| Branch | `fix/public-surface-hygiene` |
| Gate | None |
| Depends on | Nothing |
| Touches | `src/routes/public-catalog.ts`, `src/routes/admin-settings.ts`, `src/engine/curriculum.ts::getDripMode` only, matching tests |
| Off-limits | Everything else in `src/engine/curriculum.ts`; every other file |

**Prompt:**

```
Senior engineer, @emdash/lms-core. Read AUDIT.md sections M3, M10 and CLAUDE.md.

Mission: fix two public-surface correctness issues.

Files you may edit:
- src/routes/public-catalog.ts
- src/routes/admin-settings.ts
- src/engine/curriculum.ts   (ONLY getDripMode, line 67-70)
- tests/integration/routes/public-catalog.test.ts
- tests/unit/routes/admin-settings.test.ts

Do not touch anything else in src/engine/curriculum.ts.

Changes:

1. M3 — catalog search pagination coherence.
   src/routes/public-catalog.ts:154-163 filters after pagination, so search=X
   with a cursor skips matches. Rewrite: loop over upstream pages, accumulate
   filtered results until either `limit` matches collected or upstream
   exhausted (with a hard cap of 10 upstream pages to bound the work). Return
   a synthetic cursor encoding upstream position + filter params, decode on
   next call. Keep the response shape { items, cursor?, hasMore } unchanged.

2. M10 — admin settings read-time type validation.
   src/routes/admin-settings.ts:112-120 readSettings falls back to defaults
   only on null. An older install with drifted types (e.g. dripMode stored as
   a number) silently fails downstream. Define a per-key schema map (Zod,
   mirror settingsPatchSchema) and validate each stored value; on failure,
   log.warn with the drifted key and value, and substitute DEFAULT_SETTINGS[key].
   Update getDripMode in src/engine/curriculum.ts:67-70 to use the same
   validation helper if that simplifies things (import from constants or a
   new util).

Acceptance:
- pnpm typecheck, lint:quick, test pass.
- New test: catalog with 3 upstream pages and search="foo" where matches are
  scattered — all matches returned in the filtered response, cursor lets the
  next call continue.
- New test: settings with dripMode=42 in KV — readSettings returns
  dripMode="immediate" (default), a warn log fires.
- Existing catalog + settings tests still pass.

Branch: fix/public-surface-hygiene. Reference "Fixes AUDIT M3, M10".
Report back.
```

---

### Track H · Trivial polish · AUDIT M4, M6, M11

| | |
|---|---|
| Branch | `fix/trivial-polish` |
| Gate | None |
| Depends on | Nothing |
| Touches | `src/engine/email-queue.ts`, `src/admin/QuizEditPage.tsx`, `src/engine/cohorts.ts`, `src/routes/instructor-cohorts.ts`, matching tests |
| Off-limits | Everything else |

**Prompt:**

```
Senior engineer, @emdash/lms-core. Read AUDIT.md sections M4, M6, M11 and CLAUDE.md.

Mission: three small fixes, one branch.

Files you may edit (exactly these):
- src/engine/email-queue.ts
- src/admin/QuizEditPage.tsx
- src/engine/cohorts.ts
- src/routes/instructor-cohorts.ts
- tests/integration/engine/cohorts.test.ts
- tests/unit/routes/instructor-cohorts.test.ts

Changes:

1. M6 — drop node:crypto.
   src/engine/email-queue.ts:23 imports randomUUID from "node:crypto". Replace
   with globalThis.crypto.randomUUID() inline (available on Node 19+ and Workers
   without nodejs_compat). Remove the node:crypto import entirely.

2. M11 — drop Math.random for quiz option ids.
   src/admin/QuizEditPage.tsx:74. Replace `id_${Date.now().toString(36)}_${Math.random()...}`
   with `crypto.randomUUID()` (or `id_${crypto.randomUUID().slice(0, 8)}` if a
   shorter id is wanted for display).

3. M4 — surface cohort import capacity failures.
   src/engine/cohorts.ts:importFromEmails currently silently drops capacity
   failures. Add `capacityRejected: string[]` to ImportResult. When addMember
   returns LEARN_COHORT_AT_CAPACITY, push the email into capacityRejected
   instead of the implicit drop. Update the route response in
   src/routes/instructor-cohorts.ts:importRoute to include capacityRejected
   and bump counts with a `capacityRejected` count. Update admin api-client
   response type if one is re-exported.

Acceptance:
- pnpm typecheck, lint:quick, test pass.
- rg '"node:crypto"' src/ returns zero matches.
- rg 'Math\.random' src/ returns zero matches (after this track).
- New test: cohort with capacity=2, import 3 emails — first two succeed, third
  is returned in capacityRejected, counts.capacityRejected === 1.

Branch: fix/trivial-polish. Reference "Fixes AUDIT M4, M6, M11".
Report back.
```

---

### Track I · Release hygiene · AUDIT M7, L1, L2, L3, L4, L6

| | |
|---|---|
| Branch | `chore/v1-release-hygiene` |
| Gate | None |
| Depends on | Nothing |
| Touches | `package.json`, `src/constants.ts`, `CHANGELOG.md`, `.changeset/initial-release.md`, new `SECURITY.md`, new `CODE_OF_CONDUCT.md`, new `.github/ISSUE_TEMPLATE/*`, new `.github/PULL_REQUEST_TEMPLATE.md`, `demos/simple/src/pages/my-learning.astro`, `README.md`, `tsdown.config.ts` (maybe), move planning docs to `docs/internal/` |
| Off-limits | Any `src/engine/`, `src/routes/`, `src/hooks/`, `src/reconcilers/` file |

**Prompt:**

```
Senior engineer, @emdash/lms-core. Read AUDIT.md sections M7, L1, L2, L3, L4, L6,
README.md, CONTRIBUTING.md, .changeset/initial-release.md and CLAUDE.md.

Mission: release-readiness hygiene. Zero runtime code changes.

Files you may edit:
- package.json
- src/constants.ts         (ONLY the PLUGIN_VERSION constant)
- CHANGELOG.md
- .changeset/initial-release.md
- README.md
- tsdown.config.ts          (optional, see step 2)
- demos/simple/src/pages/my-learning.astro
- new: SECURITY.md
- new: CODE_OF_CONDUCT.md   (use Contributor Covenant 2.1 verbatim, per
                             CONTRIBUTING.md's existing reference)
- new: .github/ISSUE_TEMPLATE/bug_report.md
- new: .github/ISSUE_TEMPLATE/feature_request.md
- new: .github/PULL_REQUEST_TEMPLATE.md
- new: .github/ISSUE_TEMPLATE/config.yml
- Move (git mv): prd-plugin.md, prompt-topics-refactor.md,
  emdash-learn-viability.md -> docs/internal/

Do not touch any src/ file other than src/constants.ts.

Changes:

1. M7 — version identity.
   Delete the ## 0.1.0 CHANGELOG.md entry (the real block will be generated by
   changeset version at publish). Confirm .changeset/initial-release.md bump
   is "major" → bumps 0.0.0 to 1.0.0 on publish. If product wants 0.1.0
   instead, flip the changeset to "minor" — check docs/v1-decisions.md for
   guidance; if silent, default to "major" → 1.0.0.
   Align src/constants.ts PLUGIN_VERSION with package.json. Preferred: make
   PLUGIN_VERSION read from package.json at build time via tsdown's `define`
   option (edit tsdown.config.ts). Fallback: hard-update the constant manually
   and document a release-checklist step to keep them in sync.

2. L1 — OSS readiness files.
   Create SECURITY.md with a responsible-disclosure contact email (use
   security@romerobaez.com as the owner email — the maintainer is
   angel@romerobaez.com per git config; email the maintainer if you want a
   separate address, but default to the main email if uncertain and note it
   in your report).
   Create CODE_OF_CONDUCT.md with Contributor Covenant 2.1 text.
   Create .github/ISSUE_TEMPLATE/bug_report.md (reproduction steps, versions),
   feature_request.md (use case, alternatives), config.yml (blank issues false,
   link to security for vulns).
   Create .github/PULL_REQUEST_TEMPLATE.md (summary, changeset reminder,
   testing done).

3. L2 — demo dev-bypass guards.
   demos/simple/src/pages/my-learning.astro:98-105 hardcodes dev-bypass auth
   links. Wrap them in `{import.meta.env.DEV && (...)}`. Add a short comment
   "DO NOT DEPLOY THIS DEMO AS-IS" above the block.

4. L3 — strip pnpm.overrides on publish.
   package.json has "pnpm.overrides.emdash": "link:../emdash/packages/core".
   Add a publishConfig-scoped override or a prepublishOnly script that removes
   pnpm.overrides from the published tarball. Test with `pnpm pack` and
   inspect the resulting tarball's package.json — pnpm.overrides must be
   absent. Do not remove it from the repo's committed package.json (dev
   convenience).

5. L4 — move planning markdown.
   git mv prd-plugin.md prompt-topics-refactor.md emdash-learn-viability.md
   into docs/internal/. Update any dangling references (rg for each filename
   before and after).

6. L6 — README i18n clarification.
   README.md currently says topics ship with "i18n". Add a short paragraph
   clarifying this means content-item translation via emdash; plugin admin UI
   strings are English-only in v1. Call out Lingui as a v1.1 item.

Acceptance:
- pnpm typecheck, lint:quick, format:check pass (no runtime test changes).
- pnpm pack && inspect the resulting .tgz: package.json contains no
  "pnpm" key.
- rg 'prd-plugin.md|prompt-topics-refactor.md|emdash-learn-viability.md' |
  grep -v docs/internal returns zero matches.
- Every new markdown file renders cleanly (no broken links, no placeholder
  TODOs left).
- demos/simple build still succeeds.

Branch: chore/v1-release-hygiene. Reference "Fixes AUDIT M7, L1, L2, L3, L4, L6".
Report back with: list of new files, list of moved files, the stripped
pnpm.overrides verification output.
```

---

## Wave 2 — dispatch after `docs/v1-decisions.md` is confirmed

**Confirm first:** open `docs/v1-decisions.md` and check each `Decision:` line matches the assumption below. If any differs, **stop and ask** — the Wave 2 prompts below assume the recommended rulings.

| Gate | Assumed decision |
|---|---|
| A | Rip the event bus |
| B | Document install/uninstall; file upstream RFC |
| C | In-plugin projection |

### Track D · Curriculum/progress projection · AUDIT C3, M2 · Gate C

**Dispatch this solo — it owns `sandbox-entry.ts`.**

| | |
|---|---|
| Branch | `fix/curriculum-projection` |
| Gate | C (assumed: projection in-plugin) |
| Depends on | Nothing, but serialize against Track C |
| Touches | `src/sandbox-entry.ts`, `src/engine/curriculum.ts`, `src/engine/progress.ts`, `src/hooks/content.ts`, `src/types/storage.ts`, `src/constants.ts` (BOOTSTRAP_VERSION bump), new `src/reconcilers/backfill-content-index.ts`, `src/hooks/cron.ts`, `src/setup/steps.ts` (new wizard step), integration tests |
| Off-limits | `src/engine/analytics.ts` (Track J owns it) |

**Prompt sketch (full prompt is large; see `docs/v1-decisions.md` Gate C for the row shape and collection declaration — paste them into your prompt):**

```
Senior engineer, @emdash/lms-core. Read AUDIT.md section C3, M2, then read
docs/v1-decisions.md Gate C in full (row shape + collection declaration live
there). Then CLAUDE.md.

Mission: eliminate the full-content-scan pattern by introducing an
in-plugin denormalized projection. This is the largest Wave 2 track —
budget a full day.

[... see docs/v1-decisions.md Gate C "Consequences for dispatching" for the
complete spec. The agent's charter:

 - Declare the course_content_index storage collection in sandbox-entry.ts
   (exact indexes + uniqueIndexes from the decisions doc).
 - Define CourseContentIndexRow in src/types/storage.ts (exact shape from
   decisions doc).
 - Add content:afterSave and content:afterDelete handlers to src/hooks/content.ts
   for lessons + topics collections. Upsert on published status change; delete
   row on draft-back / item deletion.
 - Rewrite listLessonsForCourse, listTopicsForCourse,
   listPublishedTopicsForCourse, listPublishedTopicsForLesson in
   src/engine/curriculum.ts and src/engine/progress.ts to query the projection.
 - Rewrite evaluateCourseComplete to count by projection predicate.
 - Keep ctx.content.get(...) only for the single-item reads that need body/
   video_url/summary (student opening one lesson).
 - Add uniqueIndexes: [["userId", "stepType", "stepId"]] on step_progress
   in sandbox-entry.ts (M2).
 - Bump BOOTSTRAP_VERSION to 3 in src/constants.ts.
 - New reconciler src/reconcilers/backfill-content-index.ts that seeds the
   projection on first run (scan content, upsert rows) and sweeps for drift.
   Register in src/hooks/cron.ts ROUTES.
 - New wizard step in src/setup/steps.ts that runs the backfill on re-run.]

Acceptance:
- pnpm typecheck, lint:quick, test pass.
- rg 'ctx\.content\.list\(' src/engine/curriculum.ts src/engine/progress.ts
  returns zero matches (all list calls replaced with projection queries).
- New integration test: 50-lesson, 5-topic-per-lesson course. Measure
  storage call count on progress:tick past 90% — assert bounded (O(1)
  content.get + O(topics-in-lesson) step_progress ops, no full scan).
- New integration test: create a lesson via ctx.content.create then
  immediately call curriculum.forUser — projection row exists, appears in
  output.
- New integration test: delete a lesson — projection row is gone, curriculum
  excludes it.
- New integration test: backfill reconciler on a store with existing lessons
  + topics but no projection — all rows populated, idempotent on re-run.

Branch: fix/curriculum-projection. Reference "Fixes AUDIT C3, M2".

Report back with: any drift edge cases you encountered, the observed
storage-call-count reduction numbers.
```

### Track C · Event bus rip · AUDIT C1, H4 · Gate A

**Dispatch after Track D merges.**

| | |
|---|---|
| Branch | `fix/event-bus-rip` |
| Gate | A (assumed: Rip) |
| Depends on | Track D merged (to avoid `sandbox-entry.ts` conflicts) |
| Touches | delete `src/engine/event-bus.ts`, delete `src/engine/idempotency.ts`, `src/engine/enrollments.ts`, `src/engine/progress.ts`, `src/engine/quizzes.ts`, `src/types/engine.ts`, `src/types/storage.ts`, `src/kv-keys.ts`, `src/sandbox-entry.ts`, new `src/reconcilers/send-lifecycle-emails.ts`, `src/hooks/cron.ts`, delete unit tests for event-bus + idempotency, update integration tests that use `eventBus.on(...)` |
| Off-limits | `src/engine/certificates.ts` (Track A), `src/engine/analytics.ts` (Track J) |

**Prompt:**

```
Senior engineer, @emdash/lms-core. Read AUDIT.md section C1, then
docs/v1-decisions.md Gate A (Decision: Rip). Then CLAUDE.md.

Mission: remove the one-sided event bus and replace it with a reconciler-
driven lifecycle-email delivery path.

Deletes:
- src/engine/event-bus.ts
- src/engine/idempotency.ts
- tests/unit/engine/event-bus.test.ts
- tests/unit/engine/idempotency.test.ts

Modify:
- src/engine/enrollments.ts — remove the emit(...) block after successful
  grant and after successful revoke. Delete the import.
- src/engine/progress.ts — remove emit(...) calls for lesson:completed,
  topic:completed, course:completed. Delete the import.
- src/engine/quizzes.ts — remove emit(...) call for quiz:attempted. Delete
  the import.
- src/types/engine.ts — delete the EngineEvent / EngineEventName types.
- src/types/storage.ts — add welcomeSentAt?: string and completionSentAt?: string
  to Enrollment.
- src/kv-keys.ts — remove handledKey and the handled:* namespace docs.
- src/sandbox-entry.ts — remove any event-bus-related imports. Register the
  new send-lifecycle-emails reconciler in the cron hook wiring (actually
  that's src/hooks/cron.ts).
- src/hooks/cron.ts — add "send-lifecycle-emails" to the ROUTES map.

Integration tests that call eventBus.on(...) (e.g.
tests/integration/engine/enrollments.test.ts) — replace those assertions
with the new reconciler-based flow: seed an enrollment, run the reconciler,
assert outbox has a welcome message and enrollment.welcomeSentAt is stamped.

Create:
- src/reconcilers/send-lifecycle-emails.ts. Two sweeps, both idempotent:
    (a) Scan enrollments for { revokedAt: undefined, welcomeSentAt: undefined }.
        For each, resolve user + course, call email-queue.send (welcome subject
        + short body referencing course title), stamp welcomeSentAt on the
        enrollment row.
    (b) Scan enrollments for { completedAt: set, completionSentAt: undefined }.
        Same shape for completion email. Body can include a note about
        certificates being issued (but certificates is a separate
        reconciler — don't couple).
  Safety cap + per-item try/catch like the existing reconcilers.

Acceptance:
- pnpm typecheck, lint:quick, test pass.
- rg 'emit\(|event-bus|__resetHandlersForTests|EngineEvent' src/ returns zero matches.
- New integration test: seed one active enrollment, run reconciler twice —
  outbox has exactly one welcome message, welcomeSentAt stamped on first
  run, no duplicate on second run.
- New integration test: completed enrollment — exactly one completion email,
  completionSentAt stamped, no duplicate on re-run.

Branch: fix/event-bus-rip, off develop AFTER Track D merges. Reference
"Fixes AUDIT C1, H4".

Report back.
```

### Track F · Install/uninstall lifecycle · AUDIT C4, C5, H7, H8 · Gate B

**Dispatch after Track D merges. Can run in parallel with Track C.**

| | |
|---|---|
| Branch | `fix/install-uninstall-lifecycle` |
| Gate | B (assumed: Document, file upstream RFC) |
| Depends on | Track D merged (shares `sandbox-entry.ts`) |
| Touches | `src/sandbox-entry.ts`, every route file (add a setup-precheck helper they all share), `src/admin/SetupWizardPage.tsx`, `src/admin/api-client.ts`, README, CONTRIBUTING, new `docs/upstream/plugin-schema-api.md` |
| Off-limits | `src/engine/*` (no engine changes required) |

**Prompt:**

```
Senior engineer, @emdash/lms-core. Read AUDIT.md sections C4, C5, H7, H8, then
docs/v1-decisions.md Gate B (Decision: Document + upstream RFC). Then CLAUDE.md.

Mission: make install/uninstall honest.

Files you may edit:
- src/sandbox-entry.ts
- src/authz.ts or new src/setup-gate.ts (your choice) — add a reusable
  ensureSetupComplete(ctx) helper
- every route file under src/routes/ that is not a setup:* route — add a
  setup precheck early in the handler
- src/admin/SetupWizardPage.tsx
- src/admin/api-client.ts (new endpoints for drop-data + whoami)
- README.md
- CONTRIBUTING.md
- new: docs/upstream/plugin-schema-api.md

Do not touch src/engine/*.

Changes:

1. C5 — gate every data route on BootstrapState.
   Add a helper that reads state:bootstrap and returns
   LEARN_SETUP_INCOMPLETE when version < BOOTSTRAP_VERSION. Add a structured
   payload { setupPath: "/_emdash/admin/plugins/lms-core/setup" } to the
   PluginRouteError details. Every route handler calls this as the first
   gate after auth (public:true routes too, except setup:* themselves).

2. C4 / H8 — make uninstall honest.
   src/sandbox-entry.ts plugin:uninstall. When deleteData === true, stop the
   silent fetch. Instead, check whether the three content collections
   (courses, lessons, topics) exist — use ctx.content.list({ limit: 1 }) per
   slug; if any returns non-empty (i.e. collection exists and has data),
   throw an error with a message instructing the admin to open the wizard
   and run "Drop plugin data" first. Plugin storage is still dropped by
   emdash core automatically.

3. H7 — SetupWizardPage admin guard + Drop data action.
   src/admin/SetupWizardPage.tsx. On mount, call a new whoami-style
   endpoint (either a new admin:whoami route or repurpose admin:settings:get
   which is already ADMIN-gated) to detect the caller's role. Show a "you
   must be admin" state if not admin, instead of letting apply calls 403.
   Add a separate "Drop plugin data" panel under the main wizard that
   DELETEs the three collections via the schema endpoint with admin session
   cookies. Gate with a double-confirm + role check.

4. README + CONTRIBUTING updates.
   README "Quick start" becomes two steps explicit: (1) pnpm add + register
   in astro.config (2) open the wizard. Add a warning banner that step 2 is
   required. CONTRIBUTING gets a "Uninstalling with data deletion" section
   pointing at the wizard's Drop-data action.

5. docs/upstream/plugin-schema-api.md — draft an RFC for emdash. ~500 words:
   the API shape you want on PluginContext (ctx.schema.createCollection,
   ctx.schema.deleteCollection, ctx.schema.updateCollection), why it's
   needed (cite this track's finding), what the alternative is (what
   lms-core ships in v1 without it), security/permission considerations
   (who can mutate schema — plugin's capability model).

Acceptance:
- pnpm typecheck, lint:quick, test pass.
- New integration test: BootstrapState.version=0, call catalog route ->
  LEARN_SETUP_INCOMPLETE with setupPath in the error payload.
- New integration test: BootstrapState.version=BOOTSTRAP_VERSION, call
  catalog route -> normal response.
- New integration test: plugin:uninstall({deleteData: true}) with non-empty
  courses collection -> throws; deleteData: false -> returns clean.
- Manual test sketch in report: open the wizard as a non-admin -> see
  "you must be admin" state.

Branch: fix/install-uninstall-lifecycle, off develop AFTER Track D merges.
Reference "Fixes AUDIT C4, C5, H7, H8".

Report back with the RFC content and the list of routes that got the new
setup precheck.
```

### Track J · Analytics caching · AUDIT M5

**Dispatch after Track D merges. Can run in parallel with Tracks C + F.**

| | |
|---|---|
| Branch | `fix/analytics-cache` |
| Gate | None (but benefits from D's projection) |
| Depends on | Track D merged |
| Touches | `src/engine/analytics.ts`, new `src/engine/analytics-cache.ts` (optional), matching tests |
| Off-limits | Everything else |

**Prompt:**

```
Senior engineer, @emdash/lms-core. Read AUDIT.md section M5, and the
post-Track-D shape of src/engine/curriculum.ts (the projection helpers). Then
CLAUDE.md.

Mission: bound per-request storage scans in analytics, add opt-in TTL cache
for admin dashboards.

Files you may edit:
- src/engine/analytics.ts
- new: src/engine/analytics-cache.ts
- tests/integration/engine/analytics.test.ts

Changes:

1. Per-request memoization. Refactor each analytics handler so it takes a
   scope object that caches scanAll + courseTitle + countLessons results
   within the lifetime of one request. No global caching yet.

2. KV-backed TTL cache for expensive admin routes.
   siteAnalytics, coursesComparison, engagementMetrics each scan every
   enrollment + step_progress + certificates row. Add a thin cache layer
   keyed on (route, params-hash, dateBucket) with configurable TTL (default
   60s). Cache writes go into ctx.kv under "cache:analytics:<key>". On
   miss, compute and store. On hit, return immediately.

3. Use Track D's projection. Where analytics calls countLessons or
   countTopics via countContentInCourse (which full-scans content), switch
   to querying course_content_index with { courseId, stepType } count — the
   projection already has row-level data.

Acceptance:
- pnpm typecheck, lint:quick, test pass.
- Existing analytics tests still pass.
- New test: call dashboardStats twice within the TTL — second call makes
  zero storage scans (assert via a spy or a scan-counter on the test ctx).
- New test: call dashboardStats, wait past TTL, call again — storage scans
  happen on both calls.

Branch: fix/analytics-cache, off develop AFTER Track D merges. Reference
"Fixes AUDIT M5".

Report back.
```

---

## Wave 3 — verification

Dispatch after all Wave 2 branches merge. Single agent. Produces a resolution report, no code changes unless a regression is found.

| | |
|---|---|
| Branch | n/a (writes report only; optional fix-up commits) |
| Gate | All Wave 2 complete |
| Subagent type | `general-purpose` (needs Bash, Read, WebFetch) |
| Touches | Writes new `docs/AUDIT-v1-resolutions.md`; optional small fixes to regressions |
| Off-limits | No broad rewrites — verification only |

**Prompt:**

```
Senior engineer doing a pre-release verification pass on @emdash/lms-core.

Your job: for every finding in AUDIT.md, confirm it's been addressed, and
produce docs/AUDIT-v1-resolutions.md mirroring the AUDIT.md structure.

For each finding:
- Read the finding and its evidence line ranges in AUDIT.md.
- Open the current file at those lines and verify the fix.
- Mark one of:
    - FIXED (commit hash that fixed it, new line numbers if changed)
    - DEFERRED (link to an ADR under docs/adr/ or an issue)
    - REJECTED (with a 1-sentence reason)
- Flag any finding that claims "fixed" but where the evidence doesn't match.

Then run the verification tasks from docs/v1-dispatch-plan.md's "Verification"
block:

1. S1 / bundle size — pnpm build, ls -la dist/, report size of
   sandbox-entry.mjs and whether any React symbols leaked (rg '\\bReact\\b'
   dist/sandbox-entry.mjs).
2. S3 / envelope contract — write a new test in
   tests/integration/routes/envelope-contract.test.ts that exercises a
   public route and asserts the response body is { data: ... } (not raw).
3. S4 / load test sketch — describe (don't run) a k6 or autocannon command
   that would validate progress:tick subrequest count. Include the command
   and the expected ceiling.
4. S5 / ctx.user shape — write a test that asserts ctx.user is present on
   every gated route handler and is UserInfo | null, not unknown.

If you find any regression or broken acceptance, commit a small fix on a
fix/post-audit-regressions branch and note it in the resolution doc.

Report back with: the resolution doc path, the bundle-size numbers, the
envelope-contract test result, the load-test command, any regressions
found + fixed.
```

---

## File ownership matrix (quick reference)

| File | Wave 1 | Wave 2 | Wave 3 |
|---|---|---|---|
| `src/engine/certificates.ts` | **A** | — | — |
| `src/engine/quizzes.ts`, `src/routes/quizzes.ts` | **B** | — | — |
| `src/engine/enrollments.ts`, `src/hooks/comment.ts` | **E** | — | — |
| `src/routes/public-catalog.ts`, `src/routes/admin-settings.ts` | **G** | — | — |
| `src/engine/email-queue.ts`, `src/admin/QuizEditPage.tsx`, `src/engine/cohorts.ts` | **H** | — | — |
| `src/sandbox-entry.ts` | A adds 1 collection only | **D owns**; then C + F rebase | — |
| `src/engine/curriculum.ts`, `src/engine/progress.ts`, `src/hooks/content.ts` | — | **D** | — |
| `src/engine/analytics.ts` | — | **J** | — |
| new `src/reconcilers/send-lifecycle-emails.ts` | — | **C** | — |
| new `src/reconcilers/backfill-content-index.ts` | — | **D** | — |
| `src/admin/SetupWizardPage.tsx`, `src/admin/api-client.ts` | — | **F** | — |
| `src/types/engine.ts`, delete event-bus + idempotency | — | **C** | — |
| `src/types/storage.ts` | — | **C** (add `welcomeSentAt`, `completionSentAt`), **D** (add `CourseContentIndexRow`) — coordinate | — |
| `src/kv-keys.ts` | — | **C** | — |
| `src/constants.ts` | **I** (PLUGIN_VERSION) | **D** (BOOTSTRAP_VERSION) — coordinate | — |
| `package.json`, `CHANGELOG.md`, `.changeset/*`, `SECURITY.md`, etc. | **I** | — | — |

**Coordination notes:**
- Track A adds one storage collection to `sandbox-entry.ts`. Track D completely rewrites the collection block. Track D merges second → trivial manual rebase.
- Tracks C and D both edit `src/types/storage.ts` additively (different interfaces). Merge D first; C rebases cleanly.
- Tracks D and I both edit `src/constants.ts` (BOOTSTRAP_VERSION vs PLUGIN_VERSION). Different lines → clean auto-merge.

---

## One-shot dispatch scripts

**Wave 1 (single orchestrator message):**

Run six `Agent` tool calls in one response. Each one:
- `description`: short track name (e.g. "Fix cert credentialing")
- `subagent_type`: `general-purpose`
- `isolation`: `worktree`
- `prompt`: the block above, verbatim

**Wave 2 step 1:** one `Agent` call for Track D, no isolation (it's solo).

**Wave 2 step 2:** after D merges, three `Agent` calls in one message — C, F, J — with `isolation: "worktree"`.

**Wave 3:** one `Agent` call for the verification agent.

---

## What this plan does not cover

- Upstream emdash changes (Gate B's RFC; Gate C's alternative server-side filter). Tracked only via the `docs/upstream/*.md` files Track F writes.
- PR creation, merging, releasing. That's the maintainer's gate.
- Design review of admin UX (inline styles, a11y contrast) beyond what's already audited. Deferred to v1.1.
- Full Lingui / i18n buildout. Track I clarifies the README; implementation is v1.1.

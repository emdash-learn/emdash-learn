# v1 decision log

Three gates must resolve before the Wave 2 subagent tracks can dispatch. This doc records the choice, the reason, and the downstream consequences for each. The recommendations below are the auditor's; overwrite the `Decision:` line of any gate to change the ruling, and the dispatched agents will follow what's written here.

See `AUDIT.md` for the underlying evidence. See the fix-plan tracks (A–J) for the work that depends on each gate.

---

## Gate A — Event bus fate

**Question.** Register real handlers, or rip the bus out for v1?

**Context.** `emit()` is called from `src/engine/{enrollments,progress,quizzes}.ts`. `on()` is called only in tests. Every `enrollment:created` / `lesson:completed` / `topic:completed` / `course:completed` / `quiz:attempted` emission is a no-op in production. Comments across the engine promise "fan-out" (welcome email, instructor notify, completion email) — none of it runs.

**Options.**

- **Register.** Add `src/handlers/` with three or four handlers (welcome, completion, optional instructor-notify). Wire via `on(...)` from `sandbox-entry.ts`. Each handler reads KV settings, enqueues via `email-queue.send`, idempotency via `handled:*`. Preserves the event model as public API.
- **Rip.** Delete `src/engine/event-bus.ts`, delete every `emit(...)` call, delete `src/engine/idempotency.ts` + `handled:*` KV, delete the associated unit tests. Add one new reconciler (e.g. `send-lifecycle-emails`) that scans `enrollments` for rows whose `welcomeSentAt` / `completionSentAt` is unstamped and sends + stamps. Reconcilers become the sole fan-out path.

**Decision: Rip.**

**Why.**
- The reconciler pattern already delivers the one side-effect that currently works (`issue-certificates.ts`). Same pattern scales to welcome + completion emails with stamping for idempotency.
- `critical: true` on the current emits is misleading — there is no critical delivery guarantee because there is no consumer. Shipping that API at v1 bait-and-switches future contributors who write handlers that silently do nothing.
- Removing the bus deletes ~150 LOC and shrinks the v1 public surface. An event bus should be introduced when it has real consumers on day one, not before.
- The cost is a minor latency bump on welcome/completion email (next cron tick, not inline) — acceptable for this product.

**Consequences for dispatching.**
- Track C becomes the "rip" shape: delete `event-bus.ts` + `idempotency.ts`, remove 6 `emit(...)` call sites, add `src/reconcilers/send-lifecycle-emails.ts`, extend `enrollments` schema with `welcomeSentAt?: string` and `completionSentAt?: string` fields in `src/types/storage.ts` (no migration needed — optional fields on plugin storage rows), register the reconciler in `src/hooks/cron.ts`.
- Acceptance: `rg 'emit\(|event-bus|__resetHandlersForTests' src/` returns zero matches; integration test that seeds an enrollment and runs the reconciler observes a welcome message in `outbox` within one tick; a second tick does not double-send.
- Wave 1 Track E (enrollment race) can merge independently — no conflict with the rip.

---

## Gate B — Install / uninstall lifecycle

**Question.** Push an in-process schema API upstream to emdash, or document the manual wizard step for v1?

**Context.**
- `plugin:install` only seeds KV. Collection provisioning happens in `src/admin/SetupWizardPage.tsx` via the admin browser session (which has cookies and `schema:manage` permission). The plugin is inert between `pnpm add` and the admin clicking through the wizard.
- `plugin:uninstall({deleteData: true})` tries `fetch("/_emdash/api/schema/collections/...")` with no auth headers, gets 401/403, logs a warning, and exits successfully. The admin believes their authored courses/lessons/topics are gone. They are not.

**Options.**

- **Upstream fix.** Emdash 0.6.0 exposes `ctx.schema.createCollection(...)` / `ctx.schema.deleteCollection(...)` to plugin hook contexts. `lms-core` install/uninstall become in-process one-liners. Timeline gated on emdash review, release, and a lms-core peer-dep bump.
- **Document.** Install stays inert-until-wizard; every route returns `LEARN_SETUP_INCOMPLETE` when `BootstrapState.version < BOOTSTRAP_VERSION`. Uninstall with `deleteData=true` throws loudly instead of silent-fail, with a message directing the admin to a new "Drop plugin data" action in the wizard. README and CONTRIBUTING explicitly describe the two-step install.

**Decision: Document for v1. File an upstream RFC in parallel for v1.1.**

**Why.**
- The peer dep is now `>=0.12.0` (bumped from `>=0.5.0`), but `ctx.schema` is *still* not on `PluginContext` at emdash HEAD — verified post-bump. The "wait for upstream" path remains blocked, so the wizard-session approach is still the only way to provision collections from a plugin.
- The honest-fail path is strictly better than silent-fail even after upstream ships. An admin who asked for deletion and didn't get it deserves an error, not a log warning they'll never read.
- The wizard already works for provisioning via admin session. Reusing the same session for deletion is symmetric and has no new attack surface.

**Consequences for dispatching.**
- Track F (Wave 2) is unblocked; no upstream work needed to start.
- `sandbox-entry.ts::plugin:uninstall` stops the silent fetch. When `event.deleteData === true`, throw a `PluginRouteError` (or equivalent) with a message pointing at the wizard's Drop-data action.
- `SetupWizardPage.tsx` gains a "Drop plugin data" section (gated on admin role, double-confirm) that calls `DELETE /_emdash/api/schema/collections/*` via admin session.
- Every route handler adds a `BootstrapState.version < BOOTSTRAP_VERSION` precheck that returns `LEARN_SETUP_INCOMPLETE` with a structured `{ setupPath: "/_emdash/admin/plugins/lms-core/setup" }` payload. Demo theme pages surface the setup prompt.
- README's "Quick start" grows a "Step 2: run the wizard" subsection and explicitly warns that `pnpm add` alone is not enough.
- New file `docs/upstream/plugin-schema-api.md` drafts the emdash RFC (what the API surface should be, why, what breaks without it). Track F's agent writes this.

---

## Gate C — Curriculum performance strategy

**Question.** Denormalized projection inside plugin storage, or a server-side reference-field filter upstream in emdash?

**Context.** `src/engine/curriculum.ts` and `src/engine/progress.ts` full-scan the `lessons` and `topics` content collections on every curriculum read and every progress tick, then filter `item.data.course === courseId` in process. A single `progress:tick` past the 90 % auto-complete threshold can transfer thousands of content rows (see AUDIT C3). `content.list(where)` today supports only `status`, not reference-field equality.

**Options.**

- **In-plugin projection.** New storage collection `course_content_index` maintained by `content:afterSave` / `content:afterDelete` hooks. Engine reads from the projection. Backfill reconciler for existing installs. Self-contained; ships now. Drift risk is real but bounded.
- **Upstream filter.** Emdash grows `where` support for reference fields. The lms-core change is a one-line swap. Blocked on emdash.
- **Hybrid.** Ship projection now, delete it when upstream ships. (Effectively the same as "projection" for v1.)

**Decision: Projection in-plugin. File the upstream RFC in parallel.**

**Why.**
- v1 cannot ship with the current perf profile — Wave 3's load-test will fail the `progress:tick` subrequest budget on Cloudflare Workers.
- The projection is small surface (one new collection, two content hooks, one reconciler) and sits behind the existing `listLessonsForCourse` / `listTopicsForCourse` helpers. Deleting it later is a straightforward revert.
- An emdash-level content-filter change is an architectural discussion that the v1 ship cannot gate on.
- Post-bump verification (emdash `>=0.12.0`): `ContentListOptions.where` only accepts `status` and `locale` — no reference-field equality. The projection stays load-bearing until upstream adds reference-field `where` support.

**Consequences for dispatching.**
- Track D is the largest Wave 2 track. Budget ~3× any Wave 1 track.
- New plugin-storage collection declared in `sandbox-entry.ts`:

    ```ts
    course_content_index: {
        indexes: ["courseId", "lessonId", ["courseId", "stepType"], ["courseId", "stepType", "order"]],
        uniqueIndexes: [["courseId", "stepType", "stepId"]],
    },
    ```

- Row shape captures the frozen + engine-read fields so most curriculum reads never touch `ctx.content`:

    ```ts
    interface CourseContentIndexRow {
        courseId: string;
        stepType: "lesson" | "topic";
        stepId: string;       // lessonId for lessons, topicId for topics
        lessonId?: string;    // parent lesson id for topics
        order: number;
        status: "published" | "draft" | "scheduled";
        publishedAt?: string;
        scheduledAt?: string;
        durationSeconds?: number;
        isPreview?: boolean;          // lessons only
        requiresPrevious?: boolean;
        dripOffsetDays?: number;      // lessons only
    }
    ```

- `src/hooks/content.ts` grows `content:afterSave` and `content:afterDelete` handlers for `lessons` and `topics`. Upsert on save (when status → published; delete the row when status → draft or item deleted).
- New reconciler `src/reconcilers/backfill-content-index.ts` seeds the projection on first run and sweeps for drift on a daily schedule. Registered in `src/hooks/cron.ts`.
- Engine reads switch: `listLessonsForCourse` and its siblings query `course_content_index` by indexed predicate rather than scanning content. Full-content `ctx.content.get(...)` is scoped to the single lesson/topic a user actually opens (for body, video_url, summary). `evaluateCourseComplete` counts rows in the projection.
- `BOOTSTRAP_VERSION` bumps to `3`. `setup-wizard` runs the backfill as a new step; existing installs re-running the wizard hit the new step and seed their projection.
- Wave 1 Track J (analytics caching) should rebase on Track D's projection — several analytics scans over `lessons` / `topics` can reuse it.

---

## Sign-off

Angel — overwrite any of the three `Decision:` lines above before Wave 2 dispatches. Wave 1 (Tracks A, B, E, G, H, I) is unblocked regardless and can start now. File this doc once the decisions are final; agents will read it as part of their prompts.

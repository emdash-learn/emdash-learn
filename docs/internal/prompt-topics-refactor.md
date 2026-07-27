# Subagent prompt — T28: Topics primitive (pre-1.0 refactor)

Paste into a fresh Claude Code session at `/Users/baezor/dev/lms-core/`. This is a single-task prompt, committed as one logical change on `main`.

---

You are a senior TypeScript engineer executing the Topics primitive refactor on `@emdashlms/plugin`. Working directory: `/Users/baezor/dev/lms-core/`.

## Start here

Before writing any code, read:

1. `docs/adr/0001-topics-primitive.md` — the design decision and its consequences. This prompt implements that ADR.
2. `prd-plugin.md` §5 (content model), §6.1 (curriculum), §8 (progress), §17.3 (setup wizard / bootstrap).
3. `src/sandbox-entry.ts` — plugin descriptor. The `storage` block changes; the setup wizard route is unchanged but `BOOTSTRAP_VERSION` bumps.
4. `src/engine/curriculum.ts` and `src/engine/progress.ts` — the two engines that change the most.
5. `src/admin/api-client.ts` — the typed RPC client; you add topic calls and update progress calls.
6. `tests/utils/seed.ts` and `tests/integration/` — existing test helpers and integration suite style. Match this style.
7. `demos/simple/scripts/seed-lms.ts` and `demos/simple/src/pages/` — the demo site you extend with topics.

## What is shipping

The plugin currently models **Course → Lesson → Quiz**. You are adding **Topics** as a first-class child of lessons, producing **Course → Lesson → Topic → Quiz**. Topics mirror LearnDash's `sfwd-topic` post type (one level below lesson, no nesting, inherit drip from parent lesson, no free-preview).

This is a pre-1.0 refactor. There are no published installs. You may break any shape that was not already published. The queued `major` changeset for the 1.0 release absorbs this work — do not add a new changeset.

## Deliverables

### 1. Constants and types

- `src/constants.ts` — add `TOPICS_COLLECTION_SLUG = "topics"`. Extend `LEARN_ERRORS` with `LEARN_TOPIC_LOCKED` (keep error-code naming consistent with the existing `LEARN_LESSON_LOCKED`). Bump `BOOTSTRAP_VERSION` by 1.
- `src/types/storage.ts` — remove `Progress` in its current shape. Replace with `StepProgress`:

  ```ts
  export type StepType = "lesson" | "topic";

  export interface StepProgress {
  	userId: string;
  	courseId: string;
  	stepType: StepType;
  	stepId: string;
  	parentLessonId?: string; // topic rows only
  	startedAt: string;
  	completedAt?: string;
  	percentComplete: number;
  	positionSeconds?: number;
  }
  ```

  Keep all other exports as-is.

- `src/types/engine.ts` — add `TopicCompleted` event type mirroring `LessonCompleted`.

### 2. Plugin descriptor (`src/sandbox-entry.ts`)

- Rename the `progress` storage collection → `step_progress` with indexes:
  ```ts
  step_progress: {
    indexes: [
      "userId",
      "courseId",
      "stepId",
      "stepType",
      ["userId", "courseId"],
      ["userId", "courseId", "stepType"],
      "completedAt",
    ],
  }
  ```
- In the `plugin:uninstall` handler, when `deleteData` is true, drop `TOPICS_COLLECTION_SLUG` **before** `LESSONS_COLLECTION_SLUG` (topics reference lessons) and lessons before courses. Use the same `dropCollection(slug)` helper.
- Bump the capabilities list if it needs to change (it does not — still `read:content, read:users, email:send`).
- Register the new topic routes (see below).

### 3. Setup wizard

- `src/setup/*.ts` (or wherever the wizard's collection provisioning lives) — the wizard now provisions three collections: `courses`, `lessons`, `topics`. Topics collection fields:
  - `lesson` — reference to `lessons`, required.
  - `course` — reference to `courses`, required (denormalized for query locality; the engine enforces this matches `lesson.course`).
  - `order` — integer, default 0.
  - `title` — string, required.
  - `body` — portableText.
  - `summary` — string, optional.
  - `video_url` — string, optional.
  - `duration_seconds` — integer, optional.
  - `requires_previous` — boolean, default false. Gates visibility within the lesson's topic list.
- Topic collection **does not** have `is_preview`, `drip_offset_days`, or any scheduling fields beyond emdash's built-ins.
- Admin listing for topics shows: title, parent lesson, parent course, order, status.

### 4. Engine

#### `src/engine/curriculum.ts`

- `VisibleLesson` gains `topics: VisibleTopic[]`. `VisibleTopic` shape:
  ```ts
  export interface VisibleTopic {
  	id: string;
  	title: string;
  	order: number;
  	summary?: string;
  	requiresPrevious: boolean;
  	unlocked: boolean;
  	completed: boolean;
  	percentComplete: number;
  	videoUrl?: string;
  	durationSeconds?: number;
  }
  ```
- `forUser` now reads both lessons and topics for the course (single paginated read per collection, filter by `course` reference client-side exactly like today).
- Topic gating: visible iff parent lesson is visible (enrollment or lesson is preview); unlocked iff parent lesson is unlocked AND (if `requires_previous` set) the previous topic in `order` within the same lesson is complete.
- Lesson completion logic (used for `requires_previous` on downstream lessons AND for `evaluateCourseComplete`): a lesson is "effectively complete" for gating purposes iff (a) its lesson-level `completedAt` is set, which today requires the 90% threshold. When a lesson has topics, add: a lesson-level `completedAt` can only be written after all published topics are complete. Preview lessons with topics: the preview flag applies to the lesson; topics of preview lessons are visible without enrollment but only the lesson body is "free" in the catalog sense — enrollment is still required to unlock topic bodies. (If this ambiguity bothers you, resolve it as: preview means the lesson body is free; topics inside a preview lesson are gated on enrollment like any other topic.)
- Add `getTopic(ctx, userId, topicId): Result<RuntimeContentItem>` mirroring `getLesson` — enforces enrollment + unlocked + lesson-gating for topic bodies.
- Update `myLearning` so `percentComplete` accounts for topics. Count every published step (lesson body + topics) as 1 unit; completion = completed step units / total step units.

#### `src/engine/progress.ts`

- Replace every occurrence of `lessonId` with `stepId` + `stepType`. The deterministic id becomes `prog__${userId}__${stepType}__${stepId}`.
- `tick(ctx, userId, input)` accepts `TickInput { stepType: StepType; stepId: string; positionSeconds: number; percentComplete: number }`.
- For topic ticks, resolve the parent lesson from the `topics` content collection and populate `parentLessonId` on the row.
- Auto-complete at 90% still applies to both lesson and topic rows. When a topic crosses 90% → mark topic complete → check if all sibling topics in that lesson are complete AND the lesson body itself is complete → if so, cascade lesson complete → then evaluate course complete.
- Rename `markLessonComplete` → `markStepComplete(ctx, userId, stepType, stepId)`. It emits `topic:completed` for topics, `lesson:completed` for lessons. Lesson completion additionally gates on "all child topics complete" — if a caller tries to mark a lesson complete while topics remain incomplete, return `err(LEARN_LESSON_LOCKED, "topics incomplete")` rather than writing the completion row. (The `tick` auto-path already respects this because it only triggers via the 90% threshold plus the topic check.)
- Update `evaluateCourseComplete` to require all published lessons AND all published topics to have a completed row.
- Update `getForUser` to return `StepProgress[]`.

#### `src/engine/drip.ts`

- **No change.** Drip remains lesson-only. Topics inherit via the curriculum layer.

### 5. Routes

#### `src/routes/student-progress.ts`

- Input schema switches to `{ stepType: z.enum(["lesson", "topic"]), stepId: z.string().min(1), positionSeconds: z.number().int().nonnegative(), percentComplete: z.number().min(0).max(100) }`.
- Keep route names `progress:tick` and `progress:complete`.

#### `src/routes/student-curriculum.ts`

- Response shape now nests topics under lessons. No new route names.
- Add `topic` route — request `{ topicId: string }`, returns the topic body and gating metadata. Mirrors the existing `lesson` route.

#### `src/routes/instructor-topics.ts` (NEW)

- Follow the pattern in `src/routes/quizzes.ts`.
- Routes: `topic:list` (filter by `lessonId` or `courseId`), `topic:get`, `topic:create`, `topic:update`, `topic:delete`, `topic:reorder` (accepts an ordered array of topic ids).
- Capability: same as instructor lesson authoring. Reuse the existing authz helpers in `src/authz.ts`.

Register the new route module in `src/sandbox-entry.ts` alongside the others.

### 6. Admin UI (`src/admin/`)

- `CoursePage.tsx` — Curriculum tab becomes a two-level tree. Each lesson row expands to show its topics with drag-to-reorder and "Add topic" at the lesson row. Use Kumo components (`Button`, `LinkButton`, etc.). All new strings go through Lingui (`useLingui` + `Trans`); mirror the existing course-detail strings' catalog entries.
- New file `TopicEditPage.tsx` — portable-text editor for topic body. Mount at `/courses/:courseId/lessons/:lessonId/topics/:topicId`. Reuse the lesson editor's Portable Text integration; the topic has no drip/preview fields, so the side panel is simpler.
- `StudentProgressPage.tsx` — show per-topic completion under each lesson.
- `api-client.ts` — add typed methods for every new topic route. Update `progress:tick` / `progress:complete` method signatures to the new input shape.
- Every user-facing string goes through Lingui. Follow the existing `useLingui` / `Trans` / `msg` patterns in `CoursePage.tsx`.

### 7. Hooks

- `src/hooks/content.ts` — extend `contentBeforeDelete` so deleting a lesson cascades (or rejects, whichever you choose — **prefer reject with a clear error** unless the hook already supports cascade in related cases) when topics reference it. Deleting a course rejects/cascades when lessons or topics reference it.
- `src/reconcilers/` — if a reconciler cleans orphaned progress rows, update it to key by `(stepType, stepId)`.

### 8. Demo (`demos/simple/`)

- `scripts/seed-lms.ts` — add at least one course whose lessons have topics. Idempotent: re-running must not duplicate topics. Use the existing `upsert`-style pattern.
- `src/pages/courses/[slug]/lessons/[lesson]/index.astro` — if this page already renders lesson body + "next lesson" navigation, update it to also list the lesson's topics as a sub-navigation.
- NEW `src/pages/courses/[slug]/lessons/[lesson]/topics/[topic].astro` — topic body page. Calls the student `topic` RPC. Posts progress ticks with `{ stepType: "topic", stepId }`.
- Update `my-learning.astro` if it shows next-up — `nextLesson` might now be `nextStep` (`{ type: "lesson" | "topic", ... }`). Plumb this through.

### 9. Tests

- **Unit** — update `tests/unit/engine/progress.test.ts` and `tests/unit/engine/curriculum.test.ts` to cover:
  - Topic tick upserts a `step_progress` row with `stepType: "topic"` and `parentLessonId` populated.
  - Topic 90% auto-complete triggers `topic:completed`.
  - Lesson auto-complete requires all topics complete.
  - `requires_previous` on a topic blocks access until the previous sibling topic is complete.
  - `evaluateCourseComplete` false when any published topic is incomplete.
  - Topic visibility under a preview lesson still requires enrollment.
- **Integration** — extend `tests/integration/progress.test.ts` (or the closest equivalent) to exercise the full topic flow through the routes.
- **E2E** — extend `tests/e2e/student-journey.spec.ts` to include a topic step. Add a new spec `tests/e2e/topic-gating.spec.ts` covering requires_previous within a lesson.
- All tests must pass against a seeded demo that includes topics.

### 10. Documentation

- `README.md` — update "What's in the box → Content" bullet to include topics; update the "Site-side routes" list to include `topic`; update the Admin tour to mention the topic edit page; add a one-paragraph "Topics" subsection under What's in the box explaining the Course → Lesson → Topic hierarchy and why topics do not have preview/drip.
- `CHANGELOG.md` — the current `0.1.0` entry (or whichever version is at the top — use the one already there) gets a new bullet under "Content" and "Learning engine" calling out topics. Do NOT add a new changeset file — the existing `.changeset/initial-release.md` already bumps major; edit it to mention topics in its body.
- `docs/adr/0001-topics-primitive.md` — already exists. Do not modify.
- `prd-plugin.md` — add a short note at the top of §5 pointing to ADR 0001. Do not rewrite §5.

## Guardrails

- **Do not add backwards-compatibility shims** for the pre-1.0 `progress` → `step_progress` rename, the `lessonId` → `stepId` field rename, or any of the route input changes. Pre-1.0 means no deprecation path.
- **Do not modify `emdash` core.** If you think an emdash core change is required, stop and report it; do not patch outside this repo.
- **Do not introduce new dependencies** beyond what's already in `package.json`.
- **Do not refactor unrelated code** while you're here. No drive-bys. The rule is: if a file only needs a rename to compile, rename it; if it needs restructure beyond the topics work, leave it.
- **Localize every new user-facing string.** No bare English literals in JSX, attributes, or titles. Run `pnpm locale:extract` if the admin package provides it; otherwise follow the Lingui pattern already in `CoursePage.tsx`.
- **RTL-safe Tailwind** in any new admin UI. Use `ms-*`/`me-*`/`ps-*`/`pe-*`/`start-*`/`end-*`, never `ml-*`/`mr-*`/`left-*`/`right-*`.
- **No new ADRs.** This work is covered by ADR 0001.
- **Commits.** One PR, one commit, with message:
  ```
  T28: topics primitive (ADR 0001)
  ```
  Do not amend. If a pre-commit hook fails, fix the cause and create a new commit on top.

## Verification (run before committing)

```bash
pnpm install
pnpm typecheck
pnpm --silent lint:quick   # must return zero diagnostics
pnpm format:check          # or pnpm format if it fails
pnpm test                  # unit + integration
pnpm --filter ./demos/simple seed  # must succeed idempotently
pnpm test:e2e              # Playwright against the demo site
pnpm build                 # tsdown bundle must succeed
pnpm changeset status      # the existing initial-release.md still parses
```

All must be green. If any fail:

- Typecheck / lint / format errors: fix them.
- Test failures: fix the code, do not loosen the assertion.
- E2E flake: re-run once; if it still fails, investigate — do not mark as flaky.
- Build failure: typical cause is a missed export; chase it.

If you discover a plugin bug **unrelated to the topics refactor** while implementing (e.g. an existing engine defect), stop, leave the code untouched, and include the finding in your report. Do not silently fix unrelated bugs.

## Report back

When you finish, post a summary containing:

1. Files created (with line counts) and files modified (with approximate diff size).
2. Any design judgment calls you made beyond what this prompt specified, and why.
3. Bugs discovered but not fixed (per the guardrail above).
4. The final output of each verification command.
5. Confirmation that the initial-release changeset was updated (not replaced).
6. The commit SHA of the final commit.

If any verification step could not be run (e.g. Playwright browsers not installed), say so explicitly; do not claim success.

End of prompt.

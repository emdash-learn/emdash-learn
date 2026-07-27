# ADR 0001: Topics as a first-class primitive

> [!WARNING]
> Historical. The current product scope is Course → Lesson and is defined in
> [`../product-scope.md`](../product-scope.md). Topics were removed when the
> plugin was narrowed to the contracts available in EmDash core; the current
> compatibility target is published EmDash 0.31.

- **Status:** Superseded
- **Date:** 2026-04-18
- **Deciders:** emdash-learn maintainers
- **Supersedes:** n/a
- **Superseded by:** `docs/product-scope.md`

## Context

`@emdashlms/plugin` currently models course content as **Course → Lesson → (optional Quiz)**. Lessons are the only sub-course content unit.

We want to later ship a **LearnDash → emdash-learn migration plugin**. Research of the LearnDash data model and REST API surface (see `emdash-learn-viability.md`, sections 1–4) confirms LearnDash's canonical hierarchy is:

```
Course → Lesson → Topic → (Quiz attachable at any level)
```

Topics are not a niche feature in LearnDash. They are the default second-level organizer — virtually every non-trivial LearnDash course uses them. Topics carry their own:

- body content, order, and materials
- assignment upload / forced timer / video progression settings
- quiz attachment
- category / tag taxonomies (`ld_topic_category`, `ld_topic_tag`)

Topics differ from lessons in two constrained ways:

1. They **cannot be free-preview** ("sample" is lesson-only per LearnDash docs).
2. They **do not have independent drip scheduling** — they inherit the parent lesson's drip.

Topics also cannot nest (no topic-in-topic); the LearnDash tree is exactly three content levels deep.

Without a Topic primitive, a LearnDash import must flatten Lesson→[Topics] into a single lesson list. That is not a lossy conversion — it is **destructive**:

- URL shape changes (`/courses/x/lessons/y/topics/z` becomes `/courses/x/lessons/z` with collisions across lessons).
- Progress granularity collapses; per-topic completion becomes unobservable.
- Topic-attached quizzes lose their semantic anchor.
- The course author's information architecture is erased.

The plugin is pre-1.0 (current version `0.0.0`, initial changeset queued as `major`). Schema changes here are free — there are no published installs to migrate. **After the initial npm publish, adding Topics becomes an additive breaking change.** This window closes on the first release.

## Decision

**Add `topics` as a first-class content collection alongside `lessons`.** Do **not** model topics as self-referential lessons.

Concretely:

1. New `topics` content collection with its own `ec_topics` table, its own route family, its own admin surface.
2. Topics belong to a lesson (`lesson` reference field) and denormalize `course` for query locality.
3. Progress tracking migrates from a lesson-only `progress` collection to a unified `step_progress` collection keyed by `(stepType, stepId)` with `stepType ∈ {"lesson", "topic"}`.
4. The public `curriculum` response nests topics under lessons — the tree is explicit on the wire and in the admin UI.
5. Course-completion requires every published lesson AND every published topic in the course to be complete.

## Considered alternatives

### Alternative A — separate `topics` primitive (chosen)

A new content collection sibling to `lessons`.

**Pros:**

- Aligns with emdash's established convention: one real SQL table per collection, schema in the database.
- Invariants stay at the schema layer. Topics cannot have `is_preview` or `drip_offset_days` because those fields do not exist on the collection. No conditional logic scattered across the engine.
- URL shape stays honest: `/courses/:course/lessons/:lesson/topics/:topic`.
- 1:1 mapping to LearnDash's `sfwd-topic` post type makes the future migration plugin straightforward.
- Topics can grow their own fields (topic-specific materials, forced timer, etc.) without compromising the lesson schema.
- Admin UI can render a real nested tree without depth-tracking logic.

**Cons:**

- New routes, new admin pages, new client calls, new storage shape — more code.
- Some duplication between lesson and topic handlers (both have body / order / progress / completion), mitigated by shared helpers in `engine/curriculum.ts` and `engine/progress.ts`.

### Alternative B — self-referential `lessons` with `parent_lesson_id`

Reuse the `lessons` collection, add a `parent_lesson_id` reference, cap recursion at depth 2 in code.

**Pros:**

- Smaller code footprint. One collection, one admin page, one progress table.

**Cons:**

- Fights emdash's "one real table per collection" convention. Content collections expect a homogeneous schema.
- Every lesson query becomes a tree query or requires explicit `parent_lesson_id IS NULL` filters. Forgetting that filter is a silent correctness bug.
- Invariants leak into code. "This lesson cannot be free-preview if it has a parent" requires a runtime check on every write path.
- Depth=2 cap must be enforced both in validation and by convention; easy to violate in a future feature.
- URL routing gets awkward — `/courses/x/lessons/y/lessons/z` reads wrong and ties topic URL shape to lesson URL shape forever.
- LearnDash migration plugin has to "pretend" that a sub-lesson is a topic. Every import path carries that translation.
- If topics ever get their own fields (per-LearnDash-parity assignment upload, topic-only video progression), the shared schema cracks and we have to split anyway — with content already in the table.

### Alternative C — ship 1.0 without topics, add them later

Publish the current shape. Add topics as a v1.1 additive feature.

**Pros:**

- Ships sooner.

**Cons:**

- Migration plugin cannot launch coherently in v1.1 if the core still lacks topics — it would have to block on v1.2.
- Adding topics post-1.0 means backwards-compatible schema gymnastics: either a new collection (same as now, but harder because 1.0 installs exist) or a late-stage self-ref retrofit (Alternative B's costs without its benefits).
- Users onboarded in 1.0 build courses around lessons-only. When topics arrive later, their content doesn't retroactively gain the structure.
- The pre-1.0 window is exactly the moment to pay this cost.

## Consequences

### Schema

- **New content collection:** `topics`, table `ec_topics`. Provisioned by the setup wizard alongside `courses` and `lessons`.
- **Lesson schema unchanged** in shape but the setup wizard no longer provisions `lessons` as "the only child content" — the admin curriculum tab changes.
- **`progress` plugin storage collection renamed → `step_progress`** with these fields:
  - `userId`, `courseId` (unchanged)
  - `stepType: "lesson" | "topic"`
  - `stepId` (replaces `lessonId`)
  - `parentLessonId?: string` (topic rows only; enables "all progress within this lesson" queries)
  - `startedAt`, `completedAt`, `percentComplete`, `positionSeconds` (unchanged)
- **Indexes:** `["userId", "courseId", "stepId", "stepType", ["userId", "courseId"], ["userId", "courseId", "stepType"], "completedAt"]`. Deterministic id: `prog__${userId}__${stepType}__${stepId}`.
- Pre-1.0: no migration is needed. The rename is a schema replacement.

### Topic fields (content collection)

Required: `lesson` (reference), `course` (reference, denormalized), `order` (integer), `title`, `body` (Portable Text).

Optional: `summary`, `video_url`, `duration_seconds`, `requires_previous` (within the lesson's topic list).

**Not present** (by design, matching LearnDash constraints):

- `is_preview` — free preview is lesson-only.
- `drip_offset_days` / `scheduled_at` — topics inherit the parent lesson's drip.

### Gating semantics

- A topic is **visible** iff the parent lesson is visible (enrollment or `is_preview`).
- A topic is **unlocked** iff the parent lesson is unlocked AND, when `requires_previous` is set, the previous topic in `order` within the same lesson is complete.
- A lesson is **auto-complete** iff all its published topics are complete (if any) AND its own body reaches the 90% threshold (if it has a body; lessons with topics only and no body auto-complete when all topics complete).
- Course completion unchanged in spirit: every published lesson must be complete. Because lesson completion now cascades through topic completion, topics are transitively required.

### Routes

**Student (auth required):**

- Existing `curriculum` response gains `topics: Topic[]` on each lesson entry.
- Existing `lesson` response unchanged; add new `topic` route that returns a single topic body with the same gating rules.
- `progress:tick` and `progress:complete` accept `{ stepType, stepId }` in place of `{ lessonId }`. The old `lessonId` field is removed (pre-1.0 break; no deprecation path needed).

**Admin / instructor (auth + capability):**

- `topic:list`, `topic:get`, `topic:create`, `topic:update`, `topic:delete`, `topic:reorder` — mirror the existing lesson admin surface.

**Public:** unchanged (`catalog`, `certificate:verify`).

### Admin UI

- Course detail → Curriculum tab becomes a two-level tree (Lesson → [Topics]). Each lesson row gets an "Add topic" affordance.
- New topic edit page, mounted under the same course detail URL: `/courses/:courseId/lessons/:lessonId/topics/:topicId`.
- Student progress page surfaces per-topic completion rows, not just per-lesson.

### Demo + E2E

- Demo pages gain `/courses/:slug/lessons/:lesson/topics/:topic`.
- Seed script adds topics to at least one seeded course so the full path is exercised.
- E2E student-journey spec gains a topic-completion step; curriculum snapshot assertions updated for the nested shape.

### Setup wizard

Now provisions three content collections: `courses`, `lessons`, `topics`. Bumps `BOOTSTRAP_VERSION`. Uninstall drops `topics` first (child), then `lessons`, then `courses`.

### Versioning

- Landed as one self-contained task before the first npm publish.
- The existing `major` changeset covering the 1.0 release absorbs the topic primitive — no separate changeset needed.
- CHANGELOG and README updated inline.

### What this does not add (out of scope for this ADR)

- Assignments, essays, question banks, shared course steps, course points/prerequisites, group hierarchy, per-quiz certificates, time-limited enrollments. All tracked as lossy-but-not-blocking in `emdash-learn-viability.md` §4; revisit each as its own ADR when the migration plugin needs it.
- Topic-level taxonomies. Deferred; the generic emdash taxonomy layer covers the common case until the migration plugin proves otherwise.

## References

- `emdash-learn-viability.md` §1 (LearnDash hierarchy), §2 (REST API surface), §4 (gap analysis), §5 (recommendation).
- `prd-plugin.md` §5.2 (current lesson model), §6.1 (curriculum semantics), §8 (progress & completion), §17.3 (setup wizard & bootstrap).
- LearnDash REST v1 Topics schema: https://developers.learndash.com/rest-api/v1/v1-topics/
- LearnDash Topics docs: https://www.learndash.com/support/docs/core/topics/

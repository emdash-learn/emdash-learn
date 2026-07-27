# Emdash Learn — Product Requirements & Technical Design

> [!WARNING]
> Historical design document. Its v1 decisions are superseded by
> [`docs/product-scope.md`](../product-scope.md), which is the authoritative
> product contract targeting EmDash 0.32.0.

**Status:** Draft, in progress
**Last updated:** 2026-04-17
**Companion doc:** [`./emdash-learn-viability.md`](./emdash-learn-viability.md) (architectural feasibility analysis)

---

## 1. Context & goals

**Emdash Learn** is an open-source LMS shipped as a plugin (npm: `@emdash/lms-core`) on top of [emdash](https://github.com/emdash-cms/emdash). Product site: [emdashlearn.com](https://emdashlearn.com). It leverages emdash's CMS, admin UI, passkey auth, sandboxed plugin runtime, and content-collection schema to deliver a WordPress-class LMS without the WordPress-class security surface.

**Naming** (locked by D51, D53): product brand is **Emdash Learn**. The npm package is `@emdash/lms-core` and the plugin's runtime identifier is `lms-core`, which is what appears in admin URLs, route paths, and the monorepo directory. The `lms-*` namespace is reserved for future learning-suite packages (`@emdash/lms-theme`, `@emdash/lms-proctor`, etc.).

**Why a plugin, not a fork:**
- Content authoring (courses, lessons, rich bodies) reuses emdash's `ec_*` tables, Portable Text editor, revisions, drafts, scheduling, SEO, i18n, search, and visual editing — no reinvention.
- Admin UI reuses Kumo components, RBAC, and passkey auth.
- Deployment reuses emdash's portability (Cloudflare Workers / Node + SQLite).
- Plugin system is mature enough: sandboxed V8 isolates, indexed document storage, cron, email, Zod-validated routes, Block Kit or React admin UI.

**Non-goals (v1):**
- SCORM / xAPI compatibility
- Live video classes (synchronous teaching)
- Multi-tenant SaaS (one site = one LMS instance)
- White-label theming as a paid feature
- Marketplace payouts / revenue-share enforcement

---

## 2. Users & roles

Emdash Learn maps four personas onto emdash's existing 5-role ladder (`SUBSCRIBER=10`, `CONTRIBUTOR=20`, `AUTHOR=30`, `EDITOR=40`, `ADMIN=50`, from `packages/auth/src/types.ts:9`).

| Persona | emdash role | Additional gating |
|---|---|---|
| **Site admin** | `ADMIN` | Full plugin control. Installs, configures, assigns instructors. |
| **Instructor** | `EDITOR` *and* a row in plugin storage `course_instructors` | Plugin-side middleware enforces "instructor of this course" separately from global EDITOR. |
| **Student** | `SUBSCRIBER` | Per-course gating via `enrollments` row. |
| **Visitor** | unauthenticated | Can browse catalog + verify certificates. |

**Constraint:** emdash's role model is closed (no custom roles without core changes). The plugin works within this by using `course_instructors` as the authoritative "is this user an instructor of X" check rather than inventing a role.

---

## 3. Scope

### In v1

Courses, lessons, enrollments, progress, quizzes (server-graded), certificates (incl. PDF), cohorts, drip-scheduled content, lesson-level discussions (core comments), instructor analytics, catalog/storefront API, certificate public verification, admin setup wizard, admin quiz authoring, cohort management.

### Out of v1 (deferred, captured in §13)

**Payments of any kind** (Stripe card checkout, x402 crypto, PayPal, invoicing, coupons, refunds, tax). Courses are free in v1, or access is granted manually by an instructor/admin via `instructor:grant-enrollment`. Revenue-share payouts, SCORM/xAPI, live/synchronous classes, peer-graded assignments, gradebook export, course waitlists, prerequisites across courses, learning paths, mobile app.

**Rationale for deferring payments:** payments are genuinely orthogonal to the LMS itself — a course's pedagogical model doesn't depend on how access was granted. Removing them from v1 cuts an L-sized milestone plus the entire security surface of webhook signature verification, refund flows, and PCI-adjacent data handling. Enrollments retain a `source: "purchase"` enum value and an optional `orderId` field so admins can record externally-transacted purchases (Gumroad, invoice, bank transfer) and so the v1.1 payment integration is a pure additive change with no schema migration.

---

## 4. Architectural decisions

### 4.1 Native-format plugin, trusted mode

Chosen over sandboxed/standard format. Reasons:
- Custom Portable Text blocks (inline quiz block in lesson body) require native — sandboxed plugins cannot ship Astro components (`skills/creating-plugins/SKILL.md:146`).
- React admin UI is richer than Block Kit JSON blocks for quiz authoring and analytics.
- Trade-off accepted: not installable from the marketplace (one-click install), but self-hosters add it via `astro.config.mjs` like any other npm dependency. This matches the target distribution (open source, self-hosted).

### 4.2 Setup wizard for content collections

Plugins cannot register CMS content collections via the plugin context (`packages/core/src/plugins/types.ts:394–433` exposes no schema API). The wizard drives `/_emdash/api/schema/collections` POSTs from the admin's browser session — no privilege laundering, no upstream PR required. Full flow in §7.

### 4.3 Data layout: content for authoring, plugin storage for relations

| Lives in | What |
|---|---|
| emdash content collections (`ec_courses`, `ec_lessons`) | Courses, lessons — the authored, published, SEO-indexed, revisioned, i18n-translatable, search-indexed content. |
| Plugin storage (scoped, indexed document collections) | Enrollments, progress, quiz definitions, quiz attempts, certificates, cohorts, memberships, instructor assignments. |

Plugin storage is the right shape for append-heavy, query-by-user/by-course relational data. Content collections are the right shape for things with URLs, SEO, and editorial workflow.

### 4.4 Frozen schema + admin-extensible custom fields

The wizard provisions a complete schema. Only a labeled subset (🔒 in §5) is read by the plugin engine — admins can add, remove, or rename non-🔒 fields freely. Plugin upgrades add fields via idempotent wizard re-runs; they never rename or retype existing fields.

### 4.5 Uninstall honors `plugin:uninstall`'s `deleteData` flag

Default: leave all data intact. When `deleteData === true`, drop `ec_courses`/`ec_lessons` via `DELETE /_emdash/api/schema/collections/:slug` and wipe plugin storage. Matches emdash's existing uninstall contract (`packages/core/src/plugins/types.ts:753–755`).

### 4.6 Event-driven, cron for reconciliation only

Business events (enrollment, completion, cert issuance) fire inline. Cron is purely reconciliation — it backfills missed events from crashes. This avoids the user-experience cost of "wait 15 minutes for your certificate."

---

## 5. Data model

### 5.1 `courses` content collection

**Config:**
```ts
{
  slug: "courses",
  label: "Courses",
  labelSingular: "Course",
  icon: "graduation-cap",
  supports: ["drafts", "revisions", "scheduling", "search", "seo"],
  urlPattern: "/courses/{slug}",
  hasSeo: true,
  commentsEnabled: false,
}
```

**Fields** (🔒 = engine-depended):

| slug | type | required | default | notes |
|---|---|---|---|---|
| `title` 🔒 | `string` | ✓ | | `maxLength: 200` |
| `subtitle` | `string` | | | `maxLength: 300` |
| `description` | `text` | | | `maxLength: 1000`, textarea widget |
| `body` | `portableText` | | | Landing page content (optional; stub courses allowed) |
| `cover_image` | `image` | | | |
| `trailer_url` | `string` | | | `maxLength: 500` |
| `difficulty` | `select` | | `beginner` | `["beginner","intermediate","advanced"]` |
| `estimated_hours` | `number` | | | `min: 0` |
| `price_cents` | `integer` | | `0` | `min: 0`. **Display-only in v1** — no checkout integration. Retained so themes can render "$49" badges and so v1.1 payment integration is additive. Engine does not read this in v1. |
| `currency` | `string` | | `USD` | ISO 4217, `pattern: "^[A-Z]{3}$"`. Display-only in v1 (see above). |
| `enrollment_open` 🔒 | `boolean` | | `true` | |
| `enrollment_opens_at` 🔒 | `datetime` | | | |
| `enrollment_closes_at` 🔒 | `datetime` | | | |

### 5.2 `lessons` content collection

**Config:**
```ts
{
  slug: "lessons",
  label: "Lessons",
  labelSingular: "Lesson",
  icon: "play-circle",
  supports: ["drafts", "revisions", "scheduling", "search", "seo"],
  urlPattern: "/lessons/{slug}",
  hasSeo: true,
  commentsEnabled: true,
  commentsModeration: "first_time",
}
```

**Fields:**

| slug | type | required | default | notes |
|---|---|---|---|---|
| `title` 🔒 | `string` | ✓ | | `maxLength: 200` |
| `course` 🔒 | `reference` | ✓ | | `collection: "courses"`, `allowMultiple: false` |
| `order` 🔒 | `integer` | ✓ | `0` | `min: 0` |
| `summary` | `text` | | | `maxLength: 500` |
| `body` | `portableText` | | | Quiz blocks embed here (native-plugin PT block) |
| `video_url` | `string` | | | `maxLength: 500` |
| `duration_seconds` 🔒 | `integer` | | `0` | `min: 0` |
| `is_preview` 🔒 | `boolean` | | `false` | Visible to unenrolled users |
| `requires_previous` 🔒 | `boolean` | | `false` | Per-lesson sequential gate |
| `drip_offset_days` 🔒 | `integer` | | `0` | Relative drip mode: unlock N days after enrollment |

### 5.3 Plugin storage collections

All indexes and uniques declared in the plugin descriptor and auto-provisioned.

```ts
// enrollments — unique (userId, courseId)
interface Enrollment {
  userId: string;
  courseId: string;
  enrolledAt: string;          // ISO
  source: "free" | "purchase" | "invite" | "admin";
  orderId?: string;            // payment provider reference
  cohortId?: string;
  completedAt?: string;
  revokedAt?: string;
  revokedReason?: string;
}
// indexes: [userId], [courseId], [enrolledAt]
// unique: [userId, courseId]

// progress — one row per (user, lesson)
interface Progress {
  userId: string;
  courseId: string;
  lessonId: string;
  startedAt: string;
  completedAt?: string;
  positionSeconds?: number;    // video resume point
  percentComplete: number;     // 0-100
}
// indexes: [userId], [courseId], [lessonId], [userId, courseId], [completedAt]

// quizzes — authored via plugin admin page
interface Quiz {
  title: string;
  description?: string;
  passingScore: number;        // 0-100
  timeLimit?: number;          // seconds; null = untimed
  timeLimitPolicy: "hard" | "soft";  // default "hard"
  randomize: boolean;
  questions: Array<{
    id: string;
    type: "mcq" | "multi" | "true_false" | "short_text";
    prompt: string;
    options?: Array<{ id: string; text: string; correct: boolean }>;
    explanation?: string;
    points: number;
  }>;
  createdAt: string;
  updatedAt: string;
}

// quiz_attempts — append-only
interface QuizAttempt {
  userId: string;
  quizId: string;
  lessonId?: string;
  startedAt: string;
  submittedAt?: string;
  answers: Array<{ questionId: string; answer: unknown }>;
  score?: number;              // 0-100
  passed?: boolean;
  overtime?: boolean;          // only set for "soft" policy
}
// indexes: [userId], [quizId], [userId, quizId], [submittedAt]

// certificates — unique (userId, courseId)
interface Certificate {
  userId: string;
  courseId: string;
  issuedAt: string;
  expiresAt?: string;
  verificationCode: string;    // public, shareable
  revokedAt?: string;
  // Note: `pdfStorageKey` is not in v1. Added in v1.1 when PDF rendering ships.
  // Additive, safe to introduce later without migration.
}
// indexes: [userId], [courseId], [verificationCode], [issuedAt]
// unique: [userId, courseId], [verificationCode]

// cohorts
interface Cohort {
  slug: string;
  title: string;
  startAt?: string;
  endAt?: string;
  capacity?: number;
  createdAt: string;
}
// indexes: [slug]; unique: [slug]

// cohort_members — unique (cohortId, userId)
interface CohortMember {
  cohortId: string;
  userId: string;
  joinedAt: string;
  role: "student" | "ta";
}
// indexes: [cohortId], [userId]; unique: [cohortId, userId]

// course_instructors — unique (courseId, userId)
interface CourseInstructor {
  courseId: string;
  userId: string;
  role: "lead" | "co" | "ta";
  bioOverride?: string;
  // revenueSharePct deferred to post-v1
}
// indexes: [courseId], [userId]; unique: [courseId, userId]
```

---

## 6. API routes

All routes are plugin-scoped under `/_emdash/api/plugins/lms-core/<name>`. POST-only (emdash convention). Inputs Zod-validated. Auth: `public` = open; `role≥X` = session user must meet; `owner` = resource-ownership check against plugin storage.

### 6.1 Student-facing

| Route | Auth | Input | Returns |
|---|---|---|---|
| `enroll` | `role≥SUBSCRIBER` | `{ courseId, orderId?, cohortId?, source }` | `{ enrollmentId }` |
| `unenroll` | `owner` | `{ enrollmentId, reason? }` | `{ ok }` |
| `curriculum` | `role≥SUBSCRIBER` | `{ courseId }` | lesson metadata with drip/gating applied |
| `lesson` | `role≥SUBSCRIBER` | `{ lessonId }` | full lesson body; enforces unlocked + enrolled (or `is_preview`) |
| `progress:tick` | `owner` | `{ lessonId, positionSeconds, percentComplete }` | `{ ok }` — client calls every 15s |
| `progress:complete` | `owner` | `{ lessonId }` | `{ courseComplete: boolean }` |
| `quiz:start` | `role≥SUBSCRIBER` | `{ quizId, lessonId? }` | `{ attemptId, questions, startedAt, timeLimit? }` |
| `quiz:submit` | `owner` | `{ attemptId, answers }` | `{ score, passed, feedback }` — server-authoritative |
| `certificates:mine` | `role≥SUBSCRIBER` | `{ cursor?, limit? }` | paginated certs (record-only in v1; PDF url added in v1.1) |
| `my-learning` | `role≥SUBSCRIBER` | `{ status?: "active"\|"completed"\|"all", cursor?, limit? }` | Paginated `{ courseId, courseTitle, coverImage, enrolledAt, percentComplete, lastActivityAt, nextLesson?: { id, title }, completedAt? }` — the data a theme needs to render a "My learning" student dashboard. Cross-course summary without forcing the theme to call `curriculum` for every course. |

### 6.2 Public (no auth)

| Route | Input | Returns |
|---|---|---|
| `certificate:verify` | `{ code }` | `{ valid, issuedAt, userName, courseTitle, revokedAt? }` — rate-limited via KV |
| `catalog` | `{ cursor?, limit?, difficulty?, search? }` | paginated course listings — all `status=published` courses, theme decides rendering |

### 6.3 Instructor-facing

| Route | Auth | Purpose |
|---|---|---|
| `instructor:courses` | `EDITOR` ∩ `course_instructors` | List courses this user instructs |
| `instructor:enrollments` | same | Paginated enrollments for a course |
| `instructor:grant-enrollment` | same | Manual enrollment (invite/admin source) |
| `instructor:revoke-enrollment` | same | |
| `quiz:create` / `quiz:update` / `quiz:delete` / `quiz:list` | `EDITOR` | Quiz authoring |
| `cohort:create` / `cohort:list` / `cohort:add-member` / `cohort:remove-member` | `EDITOR` | |
| `instructor:set` | `ADMIN` | Assign a user to `course_instructors` |
| `instructor:analytics` | own course + `EDITOR` | `{ enrolled, active30d, completionRate, avgProgress, quizPassRate }` |
| `instructor:student-progress` | instructor of at least one course the student is enrolled in | `{ userId }` → `{ user, courses: Array<{ courseId, courseTitle, enrolledAt, percentComplete, lastActivityAt, lessonsCompleted, lessonsTotal, quizzes: Array<{ quizId, attempts, bestScore, passed }>, completedAt? }> }` — cross-course view for 1:1 student support. Scoped to courses where the caller is instructor. |
| `instructor:progress-export` | instructor of course + `EDITOR` | `{ courseId, format?: "csv"\|"json" }` | CSV/JSON dump of `student × lesson × percentComplete × completedAt` for external grading tools. Streamed to avoid memory spikes at scale. |

### 6.4 Admin-facing

| Route | Purpose |
|---|---|
| `admin:reconcile-certificates` | Manual sweep (backfill after bugs) |
| `admin:export` / `admin:import` | JSON dump/restore of plugin storage |
| `admin:queued-emails` | View pending-email queue |

---

## 7. Setup wizard

Admin-driven wizard at `/plugins/lms-core/setup`. Tracked by `kv.get("state:bootstrap")` (version + completedSteps). Safe to re-run after plugin upgrades — each step is idempotent with a probe/apply pattern.

| # | Step | Probe | Apply |
|---|---|---|---|
| 1 | Compatibility check | `GET /_emdash/api/version` satisfies `peerDependencies` | Refuse to continue otherwise |
| 2 | Create `courses` collection | `GET …/schema/collections/courses` → 200 | `POST …/schema/collections` with §5.1 config |
| 3 | Ensure `courses` fields | fields list matches frozen set | POST each missing field; never alter existing |
| 4 | Create `lessons` collection | `GET …/schema/collections/lessons` → 200 | `POST …/schema/collections` with §5.2 config |
| 5 | Ensure `lessons` fields | same as #3 | same |
| 6 | Initialize plugin storage | `ctx.storage.enrollments` accessible | Descriptor-driven; flag set after verify |
| 7 | Seed default settings | `settings:defaultPassingScore !== null` | Write defaults: `passingScore=70`, `certificateExpiryDays=null`, `dripMode="immediate"` |
| 8 | Register cron tasks | `ctx.cron.list()` contains `issue-certificates`, `drip-release-reminders`, `flush-email-queue` | Schedule them |
| 9 | Verify email provider | `ctx.email` defined | Warn if absent; enrollments still succeed, emails queue silently |
| 10 | Finalize | `state:bootstrap.version === BOOTSTRAP_VERSION` | Write marker, show "Setup complete" |

**Upgrade path:** bumping `BOOTSTRAP_VERSION` re-runs the wizard. New fields get POSTed; old fields untouched. One-click "Apply update" replaces a migration story.

**Error recovery:** mid-step failures recover on re-run via probes. Core `createCollection` wraps in a transaction (`packages/core/src/schema/registry.ts:141`), so a failed step 2 or 4 leaves no partial state.

**Rename detection:** if an admin renames a 🔒 field between runs, step 3/5 detects it and surfaces a repair prompt ("`price_cents` has been renamed to `price`; the engine requires the original name"). No silent repair.

---

## 8. Engine events & dispatch

### 8.1 Event catalog

All events are plugin-internal, typed, and carry an idempotency key:

```ts
type EngineEvent =
  | { name: "enrollment:created";  key: `enroll:${string}`;        data: Enrollment }
  | { name: "enrollment:revoked";  key: `revoke:${string}`;        data: { enrollmentId, reason? } }
  | { name: "lesson:completed";    key: `lc:${uid}:${lid}`;        data: Progress }
  | { name: "course:completed";    key: `cc:${uid}:${cid}`;        data: Enrollment }
  | { name: "quiz:attempted";      key: `qa:${attemptId}`;         data: QuizAttempt }
  | { name: "certificate:issued";  key: `cert:${certId}`;          data: Certificate }
  | { name: "lesson:released";     key: `rel:${lessonId}`;         data: { lessonId, scheduledAt } }
  | { name: "course:published";    key: `cp:${courseId}`;          data: { courseId } };
```

Handlers gate on `kv.get("handled:${handlerId}:${key}")` → no-op if already handled. **Keys have a 30-day TTL** (bounded storage; reconcilers retry well inside that window).

### 8.2 Dispatch rules

- **Sync** handlers run inside the originating request (client response reflects the result).
- **Async** handlers enqueue to KV and flush via `process-events` / `flush-email-queue` cron.
- **Critical** handlers fail the request on throw; **best-effort** handlers log and swallow.

| Event | Handler | Mode | Criticality |
|---|---|---|---|
| `enrollment:created` | write `enrollments` row | sync | critical |
| | welcome email | async | best-effort |
| | notify instructors | async | best-effort |
| `enrollment:revoked` | flip `revokedAt` | sync | critical |
| | revocation email | async | best-effort |
| `lesson:completed` | upsert `progress.completedAt` | sync | critical |
| | eval course-complete → emit `course:completed` | sync | critical |
| `course:completed` | write `enrollments.completedAt` | sync | critical |
| | issue cert inline → emit `certificate:issued` | sync | critical |
| | congratulations email | async | best-effort |
| `quiz:attempted` | write `quiz_attempts` | sync | critical |
| | if passed + terminal → emit `lesson:completed` | sync | critical |
| `lesson:released` | find eligible enrolled users | async | best-effort |
| | enqueue release email per user | async | best-effort |

### 8.3 Atomicity

Plugin storage (D1/SQLite) has no cross-document transactions. Pattern: **write the authoritative row first, then emit.** Handlers are idempotent and can be re-driven.

Concrete invariants:
- Enrollment row existence = enrollment happened (email is best-effort).
- `enrollments.completedAt != null` ∧ no certificate row = reconciler backfills next hour.
- `quiz_attempts` with `startedAt` and no `submittedAt` past `timeLimit` = reconciler auto-submits.
### 8.4 Cron schedule

| Task | Cadence | Purpose |
|---|---|---|
| `issue-certificates` | hourly | Backfill missed cert issuances + auto-submit stuck quiz attempts |
| `drip-release-reminders` | hourly | Email users whose lessons unlocked in the last hour |
| `flush-email-queue` | every 15 min | Drain queued emails when a provider appears |

Event-driven path is primary; cron is reconciliation only.

### 8.5 Failure-mode UX

| Scenario | User sees |
|---|---|
| No email provider | Admin banner "N emails queued"; students feel nothing |
| PDF service down | `certificates:mine` returns `pdfUrl: null`; theme shows "PDF generating" |
| Quiz timeout, hard policy | "Time expired, attempt scored as-is" on next load |
| Quiz timeout, soft policy | Attempt saved with `overtime: true`; instructor reviews |
| Lesson deletion with progress | Admin refused; prompted to archive instead |
| Plugin upgrade in flight | "Setup incomplete — N new fields to apply" banner |

---

## 9. Hooks the plugin subscribes to

| Hook | Action |
|---|---|
| `plugin:install` | Seed KV defaults (wizard triggers the rest) |
| `plugin:uninstall` | Honor `deleteData` flag per §4.5 |
| `content:afterPublish` on `lessons` | Emit `lesson:released` |
| `content:beforeDelete` on `courses` | Refuse if non-revoked enrollments exist; suggest archive |
| `content:beforeDelete` on `lessons` | Refuse if progress rows reference it; prompt archive/migrate |
| `comment:beforeCreate` | (Configurable) only allow enrolled students to comment on lesson |
| `cron` | Dispatch to `issue-certificates` / `drip-release-reminders` / `flush-email-queue` by `event.name` |

---

## 10. Frontend (site-side)

The plugin is a **backend + admin-UI** deliverable. Learner-facing pages (course catalog, course detail, lesson player, quiz taker, certificate display, "my learning" dashboard) are **not shipped by this plugin** and must be built in the Astro site consuming the plugin's routes. Rationale: themes are deeply opinionated, and shipping learner UI in the plugin would force every site to accept one visual design.

**Routes a theme needs for the learner experience** (all defined in §6):

| Theme page | Route(s) |
|---|---|
| Public course catalog (storefront) | `catalog` |
| Course detail page (public) | read `courses` content directly via emdash's Live Collections + `catalog` for price/metadata |
| "Enroll" button | `enroll` |
| "My learning" dashboard | `my-learning` |
| Course player (curriculum navigation) | `curriculum` |
| Lesson viewer | `lesson` |
| Progress tracking while viewing | `progress:tick` (15s cadence), `progress:complete` |
| Quiz taker | `quiz:start`, `quiz:submit` |
| Certificate display | `certificates:mine` |
| Public cert verification page | `certificate:verify` |

**Deferred to v1.1:** a companion `@emdash/lms-theme` starter template that wires these routes into Astro pages. For v1, we document the integration in the README.

---

## 11. Decisions log

| # | Decision | Rationale |
|---|---|---|
| D1 | Native plugin, trusted mode | Needed for inline quiz PT blocks + React admin |
| D2 | Setup wizard drives core schema API from admin session | No privilege laundering; no upstream core PR required |
| D3 | Frozen engine fields + admin-extensible custom fields | Admin flexibility without plugin fragility |
| D4 | Uninstall defaults to preserve data; `deleteData` opt-in | Matches emdash's `plugin:uninstall` contract |
| D5 | Instructor ownership via `course_instructors` (not `author_id` or a FK field) | Multi-instructor support; separates data-entry from teaching |
| D6 | Multi-currency from day one | Backfilling currency later is painful |
| D7 | `price_cents` as integer | Retail-SaaS standard |
| D8 | Per-lesson `requires_previous` | More granular than course-level sequential mode |
| D9 | `duration_seconds`, not minutes | Video resume needs second precision |
| D10 | Quizzes in plugin storage; inline via PT block | Quizzes aren't SEO content, don't need URLs |
| D11 | Discussions at lesson level (core comments) | Reuses emdash infrastructure |
| D12 | Lesson → single course (no shared lessons) | Simpler progress tracking, simpler authoring |
| D13 | `courses.body` optional | Stub courses allowed |
| D14 | Drip content in v1 | Lessons already support `scheduling` support flag |
| D15 | `revenueSharePct` deferred | Not needed before a marketplace exists |
| D16 | `drip_offset_days` on lessons from day 1 | Cheap now, migration later |
| D17 | Event-driven certs + hourly reconciliation | Users don't wait 15 min for a cert |
| D18 | Event-driven drip release + hourly reminder email | Cost-efficient + good UX |
| D19 | Silent email queue + admin banner when no provider | Enrollment never fails on email-setup gap |
| D20 | Progress tick every 15s | Balance resume accuracy vs. request volume |
| D21 | Quiz grading server-authoritative only | Credible credentialing |
| D22 | `catalog` returns all courses; theme decides paid-gate UI | Separation of concerns |
| D23 | Event idempotency markers TTL 30 days | Bounded storage; reconcilers retry well within window |
| D24 | Quiz `timeLimitPolicy` configurable per-quiz, default `"hard"` | Credible default, soft override available |
| D31 | Payments deferred entirely from v1 | Orthogonal to LMS correctness; cuts L-sized scope + security surface. Courses are free in v1 or manually granted. `price_cents`/`currency` retained as display-only; `source: "purchase"` + `orderId` retained for manual record-keeping. |
| D32 | Certificate PDF rendering deferred to v1.1 | v1 ships certs as record + public verification code only. `pdfStorageKey` field added additively in v1.1 (no migration). Removes external-service decision and template-authoring UX from v1 scope. |
| D33 | Admin site-wide analytics UI deferred to v2; backend routes built in v1 | Keeps the instructor dashboard's stat cards (§16.2) intact in v1 — those are core to the instructor experience. The broader `/analytics` page (course comparison, engagement metrics) is the deferred piece. Routes kept so v2 is pure UI work. |
| D34 | Admin UI calls plugin routes over RPC; never imports engine modules directly | Forces a clean API boundary — the engine is testable without admin UI, and the admin is testable against a mocked RPC layer. Same constraint a sandboxed plugin would have. |
| D35 | Engine functions return `Result<T>` (`{ ok: true, data } \| { ok: false, error }`); routes unwrap | Explicit errors, no thrown-error ambiguity between "user error" and "bug." Consistent with emdash's `ApiResponse<T>` envelope. |
| D36 | Error codes are SCREAMING_SNAKE_CASE with `LEARN_` prefix | Avoids collision with emdash core codes; searchable; server stays English-only (admin UI maps to localized messages client-side, per `.claude/CLAUDE.md`). |
| D37 | Student progress is first-class in v1 across three audiences | Students get `my-learning` route (theme renders dashboard); instructors see per-course heatmap (§16.3) AND per-student cross-course drill-down (§16.10a); CSV export for external tools. Progress is not "analytics" — it's core LMS correctness. |
| D38 | Lazy user provisioning in v1; no blocking on upstream `user:created` hook | First `enroll` call creates any missing plugin-side student state. Eager provisioning via a core hook would be nicer for audit-trail accuracy, but it's a 1–2 day upstream PR that may or may not land on emdash's timeline. File a Discussion, don't block v1. |
| D39 | Certificate PDF rendering deferred with the feature (D32); default direction for v1.1: `@react-pdf/renderer` | Pure JS, runs on Cloudflare Workers + Node, templates authored as JSX (maintainable by anyone who writes React), no external-service cost, no cold-start penalty. External PDF APIs considered and rejected for recurring cost + allowlist complexity. Puppeteer-in-Worker explicitly rejected (heavy runtime, compatibility friction). |
| D40 | Video hosting is provider-agnostic in v1 | `video_url` is a string; the theme renders the player. README documents Cloudflare Stream / Mux / static-R2 with example snippets. First-class integration (signed URLs, upload wizard, thumbnail extraction) is v1.1+. Plugin never touches video bytes. |
| D41 | Plugin owns zero auth surface; accepts emdash defaults | Site owner configures emdash's passkey + OAuth + magic-link stack to suit their audience. Students just need an authenticated `SUBSCRIBER`-level user. With payments cut in v1 (D31), the "B2B buyer flow" distinction dissolves entirely. |
| D42 | v1 scale target: 10k total enrollments, ~500 concurrent active learners | Plugin storage indexes (§5.3) handle this on D1/SQLite comfortably: hot queries are O(log n) via composite indexes `[userId, courseId]` and `[userId, lessonId]`. 500 concurrent × 15s progress ticks = ~33 writes/sec on the `progress` collection, well within D1's write envelope. Architectural ceiling without rework: ~100k enrollments / ~2k concurrent. Beyond that, v1.1+ adds read-through cache on `catalog` + `curriculum` (5–60s TTL) and rollup tables for `lessonsCompleted` counts. |
| D43 | Cohort capacity: transaction-guarded read-then-write; tolerate 1–2 over-enrollments at v1 scale | SQLite has no row-level locks, so a transaction-serialized `SELECT COUNT + INSERT` is the cleanest portable approach. At D42 scale, collision rate is negligible. Admin sees over-capacity state in §16.6 and adjusts manually if it happens. Strict enforcement via a distributed lock is v1.1+ if it ever matters. |
| D44 | Theme deferred to v1.1; ship minimal `demos/simple/` for integration testing in v1 | A real standalone theme is ~2 weeks; a demo site (wires every plugin route into Astro pages with plain styling) is ~0.5 week. Demo pays for itself via E2E tests (§18.7) and as a reference integration. Branded/polished theme waits. |
| D45 | License: MIT | Matches emdash core (verified via repo `LICENSE` → MIT, Cloudflare Inc.). Consistency with the platform we depend on; prioritizes adoption, which is the currency of an open LMS. |
| D46 | Co-instructor and TA see progress at the same level as the lead | Matches how real teaching works (collaborators need full visibility to help students). Adding a per-course "lead-only visibility" toggle later is additive and doesn't break anyone who relied on the default. |
| D47 | Bulk enrollment actions: instructors get reversible ones (message, revoke, cohort-move); admins-only get permanent delete | Reversibility is the principle — instructors can't cause data loss. `revokedAt` is a soft flag that can be flipped back; cohort-move is a soft change; message is read-only externally. Hard delete is admin-gated with `ConfirmDialog`. |
| D48 | Analytics retention: no rollup in v1; queries run over source tables | Plugin storage is document-based — there's no separate analytics event store to trim. Source tables (enrollments, progress, quiz_attempts) hold business data that must persist anyway. At v1 scale (D42), aggregations over source tables are fine. Daily-snapshot rollup tables are a v1.1+ perf optimization, only if needed. |
| D49 | Date range defaults: instructor dashboard = last 7d; admin analytics = last 30d (when shipped in v2) | Dashboard answers "how's this week?" (active instructors glance at it daily). Analytics answers "how's this quarter?" (admins check it weekly/monthly). v1 only needs the dashboard default since D33 defers the analytics page. |
| D50 | Cohort CSV import: email-match only; unknown emails returned as a report | Simpler + loud failure mode ("3 not found: x@a.com, y@b.com, z@c.com"). Instructor invites unknown users via emdash's existing user-invite flow. Auto-create-invite requires its own design pass (invite templates, claim flow, email delivery, edge cases like unverified addresses) — v1.1+. |
| D51 | Package name: `@emdash/lms-core`; `lms-*` prefix reserved for future learning-suite packages | Uses the `@emdash` npm scope with an `lms-` prefix to leave namespace room for future related packages (`@emdash/lms-theme` for the v1.1 companion theme, plus future candidates like `@emdash/lms-proctor`, `@emdash/lms-scorm`, `@emdash/lms-reports`). **Standalone repo**, not inside the emdash monorepo — published independently from its own GitHub repository with emdash declared as a peer dependency. |
| D52 | Ship `demos/simple/` as a minimal reference integration | 0.5 week investment. Wires every plugin route into plain Astro pages. Enables E2E Playwright tests (§18.7), serves as the copy-paste starting point for theme authors, and guards against accidental integration regressions during plugin development. |
| D53 | Product name "Emdash Learn" (brand) is distinct from plugin id `lms-core` (tech) | Product-facing surfaces — PRD, README, admin chrome label, marketing site at emdashlearn.com — use "Emdash Learn" (proper case, two words). Technical identifiers — plugin `id`, admin URL mount (`/plugins/lms-core/*`), API route prefix (`/api/plugins/lms-core/*`), standalone-repo GitHub name (`lms-core` or `emdash-lms-core` — TBD at repo creation) — use `lms-core` to match the npm package `@emdash/lms-core`. Precedent: products like React (packages `react` / `react-dom`) and Astro (package `astro`, plugins `@astrojs/*`) routinely have distinct product names and package identifiers. Consistency rule: if it shows up in a user-visible string, it's "Emdash Learn"; if it's a path, identifier, or import specifier, it's `lms-core`. |

---

## 12. Open questions

1. ~~User lifecycle hook upstream~~ — **closed by D38**: ship v1 with lazy provisioning on first `enroll`. File an emdash Discussion proposing `user:created` for v1.1, but don't block on it.
2. ~~Certificate PDF rendering service~~ — **closed by D39 (conditional)**: decision deferred alongside the PDF feature itself (D32). Default direction for v1.1: `@react-pdf/renderer` — pure JS, runs on Cloudflare Workers and Node, no external dep.
3. ~~Video hosting~~ — **closed by D40**: provider-agnostic in v1. `video_url` is a string; theme embeds the player. README documents Cloudflare Stream / Mux / R2-static patterns.
4. ~~Storefront auth flow~~ — **closed by D41**: accept emdash defaults (passkey-first + OAuth + magic link). Plugin owns zero auth surface. Payments cut in v1 eliminated the B2B-buyer distinction.
5. ~~Scale targets~~ — **closed by D42**: v1 targets 10k total enrollments and ~500 concurrent active learners. Hard ceiling for the current architecture: ~100k enrollments / ~2k concurrent, above which plugin storage becomes the bottleneck. Cache layer + rollup tables for `curriculum` / `catalog` are v1.1+ work.
6. ~~Cohort capacity enforcement~~ — **closed by D43** (transaction-guarded read-then-write; tolerate 1–2 over-enrollments at v1 scale).
7. ~~Theme in v1 vs v1.1~~ — **closed by D44** (defer standalone theme to v1.1; ship minimal `demos/simple/` for integration testing per Q17).
8. ~~License~~ — **closed by D45** (MIT, matching emdash core).
9. ~~Co-instructor visibility~~ — **closed by D46** (same visibility as lead; per-course lead-only flag is additive v1.1+).
10. ~~Bulk actions~~ — **closed by D47** (instructors: message/revoke/cohort-move; admins-only: permanent delete).
11. ~~Analytics retention~~ — **closed by D48** (no rollup in v1; queries run over source tables).
12. ~~Certificate template format~~ — **closed by D39** (same as Q2 — React component via `@react-pdf/renderer`, deferred to v1.1 with PDF feature).
13. ~~Date range picker defaults~~ — **closed by D49** (dashboard last 7d; analytics last 30d when it ships).
14. ~~Cohort capacity under concurrency~~ — **closed jointly with Q6 (D43)**.
15. ~~Cohort CSV import~~ — **closed by D50** (email-match-only; report unknowns; no auto-invite in v1).
16. ~~Package name~~ — **closed by D51** (`@emdash/lms-core`; `lms-*` prefix reserved for future learning-suite packages).
17. ~~Minimal demo site~~ — **closed by D52** (ship `demos/simple/`; enables E2E tests and serves as theme reference).
18. ~~Test coverage bar~~ — **closed by §18.2**: ≥85% engine, ≥80% routes/hooks/reconcilers, ≥70% setup, admin/blocks excluded.
19. Kumo + Lingui for SetupWizardPage — **deferred**: T01 ships the wizard page in plain HTML + inline styles so the plugin has no admin-UI runtime dep before T18 lands the typed RPC client and T19+ pulls Kumo into devDeps. `pnpm locale:extract` is likewise a Wave 6 concern. Refactor the page during Wave 6 when Kumo/Lingui are wired for every other admin page at once.
20. Schema-API reconciliations surfaced during T01 — **resolved by implementation**: (a) emdash's `CreateCollectionBody` schema (`packages/core/src/api/schemas/schema.ts`) does not accept `"seo"` in `supports` — SEO is the separate `hasSeo` flag, so PRD §5.1/§5.2 `supports: [..., "seo"]` was a drafting error. Fixtures use `supports: ["drafts", "revisions", "scheduling", "search"]` + `hasSeo: true`. (b) `createCollectionBody` also rejects `commentsEnabled`/`commentsModeration` — these must be applied via `PUT /_emdash/api/schema/collections/{slug}` after the initial POST. Steps `collection:courses` and `collection:lessons` do a create + follow-up update. (c) Every write to `/_emdash/api/schema/*` requires `X-EmDash-Request: 1` (emdash's CSRF middleware, `packages/core/src/api/csrf.ts`). The setup client sends it unconditionally. (d) Response envelopes are `{ data: <body> }` — the client unwraps `.data`.
21. `plugin:uninstall` invocation path for native plugins — **deferred to T12/T26**: emdash's `POST /_emdash/api/admin/plugins/:id/uninstall` is the marketplace uninstall endpoint; native plugins mounted via `astro.config.mjs` don't go through it. T01 wires the hook (drops `courses` + `lessons` when `deleteData=true`) and the code is unit-testable with a fake PluginContext; end-to-end coverage waits until T04's `createTestPluginCtx` lands and T26's demo-site E2E exercises the path via the admin UI.
22. T00's `test:unit` / `test:integration` scripts silently no-op — surfaced during T02 verification: `vitest run --dir tests/unit` in Vitest v4 re-resolves the config's `include` globs (`tests/unit/**/*.test.ts`) against the `--dir` path, so the effective pattern becomes `tests/unit/tests/unit/**/*.test.ts` and matches nothing. `--passWithNoTests` hides the miss — `pnpm test` exits 0 while running zero tests. T02 verified the 29 unit tests by invoking `pnpm exec vitest run` directly (no `--dir`), which honors the config's include globs and passes. **Fix applied by T04:** scripts now use positional paths (`vitest run tests/unit`, `vitest run tests/integration`), which Vitest treats as an additional glob filter rather than a root re-base. Include patterns in `vitest.config.ts` now work as advertised; T04 also adds `tests/integration/utils/self-test.ts` to the explicit include so the T04 smoke test runs under the standard scripts.
23. `Role` / `RoleLevel` / `UserInfo` not re-exported from `emdash` — **resolved by T03 with a local mirror**: the `emdash` npm package (v0.5.0) exposes `PluginContext` and `StorageCollection` but the auth-facing `Role` / `RoleLevel` types live in `@emdash-cms/auth` (not a peer dep) and `UserInfo` is internal to `packages/core/src/plugins/types.ts`. `src/authz.ts` declares local `Role` / `RoleLevel` / `UserInfo` mirrors with line-number citations back to the auth + plugins type modules. **Follow-up:** file an emdash PR that re-exports `Role`, `RoleLevel`, `UserInfo`, and `UserAccess` from the main `emdash` entry so plugins can drop the mirror. Until then the local copy is authoritative for authz; keep the values aligned on every `emdash` bump.
24. `PluginManager.install` / `.activate` don't actually run the first plugin's lifecycle hooks — surfaced during T04 fixture work: the manager's `ensureInitialized()` builds `HookPipeline` from `getActivePlugins()`, but no plugin is `active` until *after* activate completes, so the first `plugin:install` / `plugin:activate` handler call finds an empty hook list and returns zero results. Upstream even has a test (`packages/core/tests/unit/plugins/manager.test.ts`) whose comment concedes "the hook would be called in real usage" without asserting it. **Resolution for T04:** `tests/utils/test-plugin-ctx.ts` constructs `HookPipeline` directly with the resolved plugin and calls `runPluginInstall(id)`. Because `HookPipeline` registers hooks unconditionally, the install handler fires and the fixture captures its `ctx`. **Implication for T12/T14/T26:** cron/reconciler/E2E flows that go through `PluginManager` must not assume install hooks have run — either drive them via `HookPipeline` the way T04 does, or invoke `runPluginInstall` manually after `reinitialize()`. File an emdash issue proposing the manager include the about-to-install plugin in its pipeline before running lifecycle hooks.
25. Plugin capabilities for tests — T01's `definePlugin` call declares no `capabilities`, so `ctx.content` / `ctx.users` / `ctx.http` are all `undefined` on the real runtime ctx (per emdash's capability-gating in `packages/core/src/plugins/context.ts:893-920`). Integration tests need `ctx.content.create(...)` to seed courses/lessons, so `createTestPluginCtx` grants `"read:content"` / `"write:content"` / `"read:users"` on the test-wrapped `ResolvedPlugin` before handing it to `HookPipeline`. This is a fixture-only grant — the real descriptor stays capability-minimal. **Follow-up for T05+:** when engine modules first call `ctx.content` / `ctx.users` at route-handler runtime (not just in tests), add the corresponding capability to the real `definePlugin({ capabilities: [...] })` so production context shapes match the fixture.
26. Plugin route handlers receive a `RouteContext` (PluginContext + `input`/`request`/`requestMeta`) but **no session user**. `locals.user` is set by emdash's auth middleware (`packages/core/src/astro/middleware/auth.ts:357`) yet never bridged into the plugin's `ctx`, so `authz.requireRole(ctx, …)` from T03 has nothing to authorize. **Resolution for T05 (and every later student/instructor route):** route files share a small `resolveActingUser(ctx)` helper that reads `request.headers.get("X-Acting-User-Id")` and looks the user up via `ctx.users.get(id)`. The header is the explicit, debuggable shim — site themes set it after the framework authenticates the cookie. Tests inject it directly. **Follow-up:** file an emdash PR exposing the resolved session user as `ctx.user` on `RouteContext` so plugins can drop the header shim. Until then, every route file in `src/routes/` uses the helper; this is the single point of contact with the upstream gap. The shim assumes the surrounding emdash route (`src/astro/routes/api/plugins/[pluginId]/[...path].ts`) has already enforced `plugins:manage`/`plugins:read` on the underlying session, so the header is trusted within an authenticated request — a public-facing site MUST set it server-side from `Astro.locals.user` rather than echoing a client header.
27. Capability `read:users` not yet on the real `definePlugin` descriptor — discovered during T05 implementation: the route helper added in Q26 needs `ctx.users.get(...)` at request time, but T01's `createPlugin()` never declared `read:users` as a capability (per Q25 the test fixture grants it, but the production descriptor does not). **Resolution for T05:** the route helper checks `ctx.users` truthiness and returns `null` (→ `LEARN_UNAUTHENTICATED`) when the capability is absent so the plugin still loads under T01's lean descriptor; an explicit follow-up note in the helper's JSDoc points at the descriptor edit a later wave (likely T18 alongside admin api-client) will own.

**All open questions resolved (Q19–Q27 are implementation notes for future waves).**

---

## 13. Risks

From `./emdash-learn-viability.md`, carried forward with mitigations now in-hand:

| Risk | Status |
|---|---|
| No plugin API to register CMS content collections | **Mitigated** via setup wizard (§7). If core adds `ctx.schema.ensureCollection()` later, wizard becomes a one-line internal call. |
| Closed role model | **Accepted.** `course_instructors` provides the missing "instructor of X" gate. Custom roles remain an emdash core concern. |
| No `user:created` hook | **Deferred.** v1 lazy-provisions on first `enroll`. Host sites can call `enroll` on signup if they want eager provisioning. |

---

## 14. Effort

Refined from viability report (§ Rough effort per feature):

| Milestone | Size | Notes |
|---|---|---|
| Plugin scaffold, setup wizard, frozen schema | M | |
| Enrollments + progress + `progress:tick` + `my-learning` + per-student drill-down + progress export | M | |
| Quiz engine (server-side grading, storage, attempts) | M | |
| Inline quiz PT block (native-plugin React) | M | |
| Certificates (record + public verification only; no PDF in v1) | S | PDF rendering deferred to v1.1 |
| Cohorts + memberships | S | |
| Drip mechanics (immediate + relative modes) | S | |
| Instructor admin pages (dashboard, course detail, enrollments, quiz authoring) | L | |
| Analytics routes (backend only; UI deferred to v2) | S | |
| Event bus + reconciliation crons | M | |
| Lesson discussions (core comments wire-up) | S | |
| Email queue + provider detection | S | |
| Catalog + certificate-verify public routes | S | |
| Docs + example integration | M | |
| `demos/simple/` minimal reference site (D52) | S | ~0.5 week; pays for itself via E2E test infrastructure |
| **v1 MVP total** | **L** | ~2.5–4 eng-months solo (payments, PDF rendering, and admin analytics UI removed from scope; demo site added) |

---

## 15. Next deliverables (order of work)

1. ~~Instructor admin page wireframes~~ — **done, see §16**
2. ~~Engine implementation sketch~~ — **done, see §17**
3. ~~Test strategy~~ — **done, see §18**

All planned deliverables landed. Next steps are execution — pick up at Phase 1 of §17.7.

---

## 16. Admin UI wireframes

Native plugin = React admin UI via `admin.entry` (per `packages/core/src/plugins/types.ts:1204–1217`). Pages are React components keyed by path, exported from `src/admin.tsx`. Every string is Lingui'd; every margin/padding uses logical RTL-safe classes (`ms-*` / `me-*`); every control comes from `@cloudflare/kumo` (per `.claude/CLAUDE.md` admin conventions). Mount path is emdash's admin shell at `/_emdash/admin/plugins/lms-core/*`.

### 16.1 Navigation & shell

Plugin declares these `adminPages` in the descriptor (listed in emdash's admin sidebar):

| Path | Label | Icon | Min role |
|---|---|---|---|
| `/` | Teaching dashboard | `graduation-cap` | EDITOR |
| `/courses/:courseId` | (dynamic, no sidebar entry) | — | instructor of course or EDITOR |
| `/quizzes` | Quizzes | `question` | EDITOR |
| `/cohorts` | Cohorts | `users-three` | EDITOR |
| ~~`/analytics`~~ | ~~Analytics~~ | — | **Deferred to v2** (routes built in v1, no sidebar entry) |
| `/instructors` | Instructor assignments | `chalkboard-teacher` | ADMIN |
| `/settings` | LMS settings | `gear` | ADMIN |
| `/setup` | Setup wizard | `wand` | ADMIN (auto-surfaces when incomplete) |

Instructors who are not EDITOR globally see a reduced sidebar (only `/`, their course pages, `/quizzes`, `/cohorts`). Admin-only pages are hidden from the sidebar via `hasPermission` gating.

### 16.2 Instructor dashboard — `/`

```
┌─────────────────────────────────────────────────────────────────────┐
│ Teaching dashboard                              [+ Create course]   │
├─────────────────────────────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                 │
│ │ Students │ │ Active   │ │ Revenue  │ │ Avg      │                 │
│ │          │ │ (7d)     │ │ (30d)    │ │ compl.%  │                 │
│ │   1,284  │ │    312   │ │  $8,420  │ │   67%    │                 │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘                 │
├─────────────────────────────────────────────────────────────────────┤
│ Your courses                                                        │
│ ┌────────────────────┬──────────┬────────────┬──────────┬────────┐  │
│ │ Title              │ Students │ Completion │ Status   │        │  │
│ ├────────────────────┼──────────┼────────────┼──────────┼────────┤  │
│ │ React Fundamentals │     412  │      73%   │ Live     │ Open → │  │
│ │ Advanced SQL       │     201  │      58%   │ Draft    │ Open → │  │
│ └────────────────────┴──────────┴────────────┴──────────┴────────┘  │
├─────────────────────────────────────────────────────────────────────┤
│ Recent activity                                                     │
│ • Maya enrolled in React Fundamentals — 2m ago                      │
│ • Josh completed Advanced SQL → certificate issued — 14m ago        │
│ • Lin passed Quiz 3 in React Fundamentals — 1h ago                  │
└─────────────────────────────────────────────────────────────────────┘
```

- Stat cards use Kumo card primitives. Numbers link to filtered views (Students → global enrollments; Revenue → analytics).
- Courses table: instructor sees only courses where they have a `course_instructors` row. Global EDITOR sees all.
- "Recent activity" = last 10 events from a plugin-internal `events` index (enrollments created, certificates issued, quizzes passed). Scoped to instructor's courses.
- "Create course" deep-links to emdash's native content creation flow for the `courses` collection.

**Queries needed** (new routes in §6):
- `instructor:dashboard-stats` → `{ totalStudents, active7d, revenue30dCents, avgCompletionPct }`
- `instructor:dashboard-courses` → list of `{ courseId, title, status, studentCount, completionPct }`
- `instructor:recent-activity` → `{ items: Array<{ type, actorName, courseTitle, happenedAt, href }> }` — last 10, scoped to instructor

### 16.3 Course detail — `/courses/:courseId`

Header: course title, status badge, "Edit content" (→ emdash content editor), "View live" (→ public URL).

Tab bar: **Overview · Enrollments · Progress · Quizzes · Cohorts · Discussions · Settings**

**Overview tab:**
```
┌ Enrolled ┐ ┌ Completed ┐ ┌ Active 7d ┐ ┌ Avg progress ┐ ┌ Revenue ┐
│   412    │ │    148    │ │     89    │ │     54%      │ │ $4,120  │
└──────────┘ └───────────┘ └───────────┘ └──────────────┘ └─────────┘

[Chart] Enrollments over time — last 30 days (line chart)

[Funnel] Completion funnel
  Started ████████████████████████ 100%
  25%     ██████████████████       78%
  50%     ██████████████           61%
  75%     ██████████               45%
  100%    ████████                 36%
```

**Enrollments tab:** embeds §16.4 filtered to this course.

**Progress tab:** student × lesson heatmap.
```
                L1   L2   L3   L4   L5   L6   ...
  Alice         ✓    ✓    ✓    75%  —    —
  Ben           ✓    ✓    50%  —    —    —
  Cora          ✓    ✓    ✓    ✓    ✓    ✓
```
Sortable by column (lesson) or row (student). Click a cell → student's detailed progress for that lesson. Pagination: 50 students per page; lessons scrollable horizontally.

**Quizzes tab:** table of quizzes attached to this course (via lesson bodies). Columns: Quiz, Attached to lesson, Attempts, Pass rate, Avg score. Row click → quiz edit (see §16.5).

**Cohorts tab:** cohorts enrolled in this course. Columns: Cohort, Members, Start-end, Completion %. Row click → cohort detail (§16.6).

**Discussions tab:** comment moderation queue, pre-filtered to lessons of this course. Reuses emdash's built-in comments UI.

**Settings tab:**
- Toggle: `enrollment_open`
- Inputs: `enrollment_opens_at` / `enrollment_closes_at`
- Override: drip mode for this course (`immediate` / `relative`), if we support per-course override (see §16.10 open questions)
- Danger zone: "Archive all enrollments" (bulk action, requires confirm modal)

**Queries needed:**
- `instructor:course-overview` → stats payload
- `instructor:course-enrollments-timeline` → daily counts last 30d
- `instructor:course-completion-funnel` → `{ started, q25, q50, q75, completed }` counts
- `instructor:course-progress-matrix` → paginated student × lesson
- `instructor:course-quiz-stats` → per-quiz aggregates for this course

### 16.4 Enrollments — `/courses/:courseId/enrollments`

```
┌─────────────────────────────────────────────────────────────────────┐
│ Filters: [Status ▾] [Source ▾] [Cohort ▾] [Date range] 🔍 Search   │
│                                       [+ Grant enrollment] [Export] │
├─────────────────────────────────────────────────────────────────────┤
│ ☐ │ Student        │ Enrolled  │ Source   │ Progress │ Last active  │
├───┼────────────────┼───────────┼──────────┼──────────┼──────────────┤
│ ☐ │ Maya Okafor    │ 12 Apr    │ Purchase │ ████ 68% │ 2h ago       │
│ ☐ │ Jon Svensson   │ 11 Apr    │ Invite   │ ██   31% │ yesterday    │
│ ☐ │ Lin Park       │ 11 Apr    │ Free     │ ────  0% │ never        │
└───┴────────────────┴───────────┴──────────┴──────────┴──────────────┘
[2 selected] [Message] [Move to cohort] [Revoke]
```

- Bulk actions in a floating toolbar when any row checked.
- "Grant enrollment" modal: user picker (autocomplete by email/name from `ctx.users.list`), cohort picker, source selector, optional note.
- Revoke uses `ConfirmDialog` + `DialogError` for error display (emdash convention per `.claude/CLAUDE.md`).
- Export = CSV download of filtered results, route below.

**Queries needed (beyond §6):**
- `instructor:enrollments-export` → CSV stream (or JSON that admin client turns into CSV).

### 16.5 Quiz authoring — `/quizzes` and `/quizzes/:quizId`

**List view:**
```
┌─────────────────────────────────────────────────────────────────────┐
│ Quizzes                                        [+ New quiz]         │
├─────────────────────────────────────────────────────────────────────┤
│ Title                  │ Questions │ Attempts │ Pass rate │         │
│ React basics           │        12 │      847 │      78%  │ Edit →  │
│ SQL joins              │         8 │      201 │      64%  │ Edit →  │
└─────────────────────────────────────────────────────────────────────┘
```

**Edit view:**
```
┌─────────────────────────────────────────────────────────────────────┐
│ [Back] Quiz: React basics                        [Preview] [Save]   │
├─────────────────────────────────────────────────────────────────────┤
│ Title            [ React basics                                  ]  │
│ Description      [ Multi-line textarea                           ]  │
│                                                                     │
│ Passing score    [ 70 ] %   Time limit [ 15 ] min  Policy [Hard▾]  │
│ ☑ Randomize question order                                          │
├─────────────────────────────────────────────────────────────────────┤
│ Questions                                    [+ Add question ▾]     │
│                                                                     │
│ ┌─ Q1. Multiple choice (1 pt) ─────────────────────── [↑↓] [⋮] ──┐  │
│ │ Prompt: What is JSX?                                            │ │
│ │ Options:                                                        │ │
│ │   ○ A transpilation target      ☐ Correct                      │ │
│ │   ● A syntax extension for JS   ☑ Correct                      │ │
│ │   ○ A templating language       ☐ Correct                      │ │
│ │ Explanation (shown after submit): JSX is a syntax extension...  │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ ┌─ Q2. True/false (1 pt) ───────────────────────────── [↑↓] [⋮] ──┐ │
│ │ Prompt: React re-renders the whole DOM on state change.         │ │
│ │ Correct: ● False                                                │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

- Drag-reorderable question list. `[⋮]` menu: duplicate, delete.
- "Add question" dropdown: MCQ, Multi-select, True/false, Short text.
- Preview mode = takes the quiz as a student would, against a dry-run attempt that's discarded on close.
- Save calls `quiz:update`; creates a new one on first save via `quiz:create`.
- Unsaved-changes guard (browser beforeunload + route change confirm).

### 16.6 Cohort management — `/cohorts` and `/cohorts/:cohortId`

**List view:** table (Slug, Title, Start–end, Members, Capacity, Actions).

**Detail view:**
```
┌ Title         [ Spring 2026 Bootcamp                       ] ──────┐
│ Slug          [ spring-2026                                ]       │
│ Start         [ 2026-05-01 ]   End [ 2026-07-31 ]                  │
│ Capacity      [ 50 ]  (Current members: 34)                        │
├────────────────────────────────────────────────────────────────────┤
│ Members                          [+ Add members] [Import CSV]      │
│ ┌ Student         │ Role    │ Joined    │                         │
│ │ Alice Rivera    │ Student │ 12 Apr    │ [remove]                │
│ │ Ben Tanaka      │ TA      │ 11 Apr    │ [remove]                │
│ └─                                                                 │
└────────────────────────────────────────────────────────────────────┘
```

- Add members modal: user picker (multi-select), role selector, or CSV paste (one email per line).
- Capacity shown inline; enrollments past capacity are rejected by the engine (see §16.10 open questions on concurrency).

### 16.7 Analytics — `/analytics` (ADMIN only) — **DEFERRED TO v2 (backend routes stay in v1)**

> The admin analytics page itself is deferred. The routes below (`admin:analytics-overview`, `admin:courses-comparison`, `admin:engagement-metrics`) **are built in v1** so that v2 ships as a pure UI addition with no data-layer work. Instructor dashboard stat cards (§16.2) are NOT affected and remain in v1.

```
┌ Date range [Last 30 days ▾]                                         ┐
│                                                                     │
│ Total students  Revenue       Completions   Avg pass rate          │
│     4,120       $28,540           1,882          71%               │
├─────────────────────────────────────────────────────────────────────┤
│ [Chart] Enrollments vs completions over time                       │
├─────────────────────────────────────────────────────────────────────┤
│ Course comparison                                                   │
│ Course          │ Enrolled │ Completion │ Revenue  │ Avg progress │ │
│ React Fund.     │    412   │     73%    │ $4,120   │    54%       │ │
│ Advanced SQL    │    201   │     58%    │ $2,010   │    47%       │ │
│ ... (sortable, paginated)                                           │
├─────────────────────────────────────────────────────────────────────┤
│ Engagement                                                          │
│ DAU / WAU ratio: 0.34   Avg session: 22m   Quiz pass rate: 71%     │
└─────────────────────────────────────────────────────────────────────┘
```

**Queries needed:**
- `admin:analytics-overview` → top-line totals + timeline
- `admin:courses-comparison` → paginated, sortable by any column
- `admin:engagement-metrics` → DAU/WAU, avg session, quiz pass

### 16.8 Settings — `/settings` (ADMIN only)

Sections (each a Kumo card):

1. **General**
   - Site LMS name (string)
   - Support email (string)
2. **Defaults**
   - Default quiz passing score (number, 0–100)
   - Certificate expiry days (null = never)
   - Drip mode (`immediate` / `relative`)
3. **Email**
   - Provider status: badge (green "Configured via plugin X" / yellow "Not configured, M emails queued")
   - "Send test email" button (if provider configured)
4. **Danger zone**
   - "Uninstall Emdash Learn" → opens emdash's standard uninstall flow; surface the `deleteData` checkbox prominently with explanation ("Preserves all student data by default. Check to wipe every course, lesson, enrollment, progress record, and certificate.")

All persisted to `ctx.kv` under `settings:*` prefix (matches plugin convention per `packages/core/src/plugins/types.ts:157–162`).

**Queries needed:**
- `admin:settings:get` → current values of all settings
- `admin:settings:update` → partial update, secret fields write-only
- `admin:test-email` → triggers `ctx.email.send` with a canned test message

### 16.9 Instructor assignments — `/instructors` (ADMIN only)

```
┌ Instructors                                   [+ Assign instructor] ┐
│ User                  │ Courses (role)                              │
│ Maya Okafor           │ React Fundamentals (lead), SQL (co)         │
│ Ben Tanaka            │ Advanced SQL (lead)                         │
│ Lin Park              │ React Fundamentals (TA)                     │
└─────────────────────────────────────────────────────────────────────┘
```

- "Assign" modal: user picker + course picker + role selector (`lead` / `co` / `ta`).
- Click a user row → their full assignments with remove buttons.
- Calls `instructor:set` and a new `instructor:unset` route (missing from §6, added below).

### 16.10a Per-student progress view — `/students/:userId` (instructor drill-down)

Drill-down target from §16.4 enrollments list (click a student row). Instructor-scoped: only shows courses where the caller is an instructor.

```
┌─────────────────────────────────────────────────────────────────────┐
│ [Back] Alice Rivera · alice@example.com              [Message]      │
├─────────────────────────────────────────────────────────────────────┤
│ Enrolled in 3 of your courses                                       │
│                                                                     │
│ React Fundamentals          Enrolled 12 Apr · Last active 2h ago    │
│ Progress    ████████████░░░░░░  68%     Lessons  8 / 12 complete    │
│ Quizzes     3 attempts, 2 passed (best 85%)                         │
│                                                                     │
│ Advanced SQL                Enrolled 11 Apr · Last active 3d ago    │
│ Progress    ██░░░░░░░░░░░░░░░░  12%     Lessons  1 / 8 complete     │
│                                                                     │
│ TypeScript Deep Dive        Completed 28 Mar · 🏆 Certificate       │
│ Progress    ████████████████████ 100%   Lessons  15 / 15 complete   │
└─────────────────────────────────────────────────────────────────────┘
```

Backed by `instructor:student-progress`. One route call, one page. No per-course fan-out from the client.

### 16.10 Missing routes (added to §6)

The wireframes reveal these routes not yet in the catalog:

**Student-facing:**
- `my-learning` — cross-course progress summary for "My learning" dashboard

**Instructor-facing:**
- `instructor:dashboard-stats`
- `instructor:dashboard-courses`
- `instructor:recent-activity`
- `instructor:course-overview`
- `instructor:course-enrollments-timeline`
- `instructor:course-completion-funnel`
- `instructor:course-progress-matrix`
- `instructor:course-quiz-stats`
- `instructor:enrollments-export`
- `instructor:student-progress` — cross-course view of one student (per §16.10a)
- `instructor:progress-export` — CSV/JSON dump for external grading tools

**Admin-facing:**
- `admin:analytics-overview` — **backend only in v1; UI deferred to v2** (D33)
- `admin:courses-comparison` — **backend only in v1; UI deferred to v2** (D33)
- `admin:engagement-metrics` — **backend only in v1; UI deferred to v2** (D33)
- `admin:settings:get`
- `admin:settings:update`
- `admin:test-email`
- `instructor:unset` (unassign)

### 16.11 New open questions raised by the wireframes

Added to §12:

- **Q9.** Can an instructor see progress of co-taught courses at the same level as the lead? Default yes (simpler); opt-in "lead-only visibility" later.
- **Q10.** Bulk actions on enrollments — available to instructors (not just admins)? Default yes for message/revoke/cohort-move; admin-only for permanent delete.
- **Q11.** Analytics data retention — do we keep all historical event data forever, or roll up daily after 90 days? Affects plugin storage growth at scale.
- **Q12.** Certificate template format: PDF with merge fields, HTML+CSS, or React component rendered server-side? Affects both authoring UX and rendering pipeline choice (§15 item #4).
- **Q13.** Date range picker defaults: dashboard = last 7d, analytics = last 30d?
- **Q14.** Cohort capacity enforcement: atomic read-then-write is fine at small scale; at high concurrency, over-enrollment is possible. Accept over-by-a-few and expose a moderation UI, or block via serialized endpoint?
- **Q15.** CSV member import for cohorts — match by email only, or also fall back to creating invites for unknown emails?

### 16.12 Decisions bake-in

| # | Decision | Rationale |
|---|---|---|
| D25 | Admin lives inside emdash admin shell at `/_emdash/admin/plugins/lms-core/*` | Native-plugin pattern; admins already here |
| D26 | Instructor sidebar is a reduced subset of the ADMIN sidebar | Keeps instructors out of admin-only screens without a separate app |
| D27 | Course detail uses tabs (Overview/Enrollments/Progress/Quizzes/Cohorts/Discussions/Settings) | Single-page navigation; mirrors content-editor pattern in emdash |
| D28 | Quiz edit has an unsaved-changes guard | Authoring data loss is expensive |
| D29 | Settings secrets (Stripe keys) use Kumo `secret` field type (write-only) | Never re-render secrets; follows `packages/core/src/plugins/types.ts:1149–1151` |
| D30 | Bulk actions surface via floating toolbar only when rows selected | Kumo standard pattern; keeps toolbar out of the way |

---

## 17. Engine implementation sketch

### 17.1 Module layout

```
<repo-root>/                         # Standalone repo per D51 (not inside emdash monorepo)
├── package.json                     # @emdash/lms-core; exports: "." (descriptor), "./sandbox", "./admin", "./astro"
├── tsconfig.json
├── src/
│   ├── index.ts                     # Descriptor factory (Vite build time)
│   ├── sandbox-entry.ts             # definePlugin() — hooks + routes wiring (request time)
│   ├── admin.tsx                    # Admin entry — exports pages/widgets as JSX
│   ├── astro/
│   │   └── index.ts                 # blockComponents export for PT block site rendering
│   │
│   ├── engine/                      # Core business logic — pure, testable, no I/O besides ctx
│   │   ├── event-bus.ts             # emit(event) → dispatch handlers by name; idempotency-gated
│   │   ├── idempotency.ts           # handled:${handlerId}:${key} KV guards (30-day TTL per D23)
│   │   ├── enrollments.ts           # grant/revoke/list/get; writes enrollments row → emits
│   │   ├── progress.ts              # tick, complete, percent calc, course-complete eval
│   │   ├── curriculum.ts            # assembles visible curriculum for a user (applies drip + gating)
│   │   ├── drip.ts                  # immediate vs relative unlock math
│   │   ├── quizzes.ts               # CRUD, grading, attempt storage, stuck-attempt detection
│   │   ├── certificates.ts          # issuance + verification (no PDF in v1)
│   │   ├── cohorts.ts               # CRUD + membership
│   │   ├── instructors.ts           # assignment + "is instructor of X" check
│   │   ├── analytics.ts             # aggregation queries (backend for deferred UI)
│   │   ├── email-queue.ts           # queue/flush when ctx.email absent
│   │   └── result.ts                # Result<T> type + helpers (ok / err / mapError)
│   │
│   ├── routes/                      # Thin wrappers over engine; authz + Zod validation here.
│   │   │                            # One file per feature — each exports a named `*Routes` object.
│   │   │                            # Composed into the descriptor via src/sandbox-entry.ts.
│   │   ├── student-enrollments.ts   # enrollmentRoutes: enroll, unenroll
│   │   ├── student-progress.ts      # progressRoutes: progress:tick, progress:complete
│   │   ├── student-curriculum.ts    # curriculumRoutes: curriculum, lesson, my-learning
│   │   ├── student-certificates.ts  # certificateRoutesStudent: certificates:mine
│   │   ├── quizzes.ts               # quizRoutes: quiz:start/submit (student) + quiz:create/update/list/delete (instructor)
│   │   ├── instructor-cohorts.ts    # cohortRoutes: cohort:create/list/add-member/remove-member/import
│   │   ├── instructor-assignments.ts # instructorAssignmentRoutes: instructor:set, instructor:unset
│   │   ├── instructor-analytics.ts  # instructorAnalyticsRoutes: dashboard/course/student queries
│   │   ├── public-certificates.ts   # certificateRoutesPublic: certificate:verify
│   │   ├── public-catalog.ts        # catalogRoutes: catalog
│   │   ├── admin-settings.ts        # adminSettingsRoutes: admin:settings:get/update, test-email
│   │   └── admin-analytics.ts       # adminAnalyticsRoutes: site-wide analytics backend (UI deferred to v2 per D33)
│   │
│   ├── hooks/                       # Emdash lifecycle hook handlers
│   │   ├── install.ts               # Seed KV defaults
│   │   ├── uninstall.ts             # Honor deleteData flag (D4)
│   │   ├── content.ts               # content:beforeDelete guards on courses/lessons
│   │   ├── comment.ts               # comment:beforeCreate — enrollment gate (configurable)
│   │   └── cron.ts                  # Dispatch by event.name to reconcilers
│   │
│   ├── reconcilers/                 # Cron-driven sweeps; all idempotent
│   │   ├── issue-certificates.ts    # Backfill missed certs + auto-submit stuck quiz attempts
│   │   ├── drip-release-reminders.ts
│   │   └── flush-email-queue.ts
│   │
│   ├── admin/                       # React admin pages (Kumo components, Lingui strings)
│   │   ├── DashboardPage.tsx        # §16.2
│   │   ├── CoursePage.tsx           # §16.3 with tabs
│   │   ├── EnrollmentsPanel.tsx     # §16.4 — reused inside CoursePage
│   │   ├── QuizListPage.tsx         # §16.5 list
│   │   ├── QuizAuthoringPage.tsx    # §16.5 edit
│   │   ├── CohortsPage.tsx          # §16.6 list
│   │   ├── CohortDetailPage.tsx     # §16.6 detail
│   │   ├── InstructorsPage.tsx      # §16.9
│   │   ├── SettingsPage.tsx         # §16.8
│   │   ├── SetupWizardPage.tsx      # §7
│   │   ├── api-client.ts            # Typed RPC wrapper over /_emdash/api/plugins/lms-core/*
│   │   └── components/              # StatCard, QuestionEditor, UserPicker, etc.
│   │
│   ├── blocks/                      # Portable Text custom blocks (native-only)
│   │   ├── QuizBlock.tsx            # Inline quiz in lesson body
│   │   └── index.ts                 # Registers blockComponents
│   │
│   ├── setup/                       # Setup wizard implementation
│   │   ├── steps.ts                 # Step definitions with probe/apply
│   │   ├── core-schema-client.ts    # REST calls to /_emdash/api/schema/* from admin session
│   │   └── schema-fixtures.ts       # Frozen courses/lessons schema specs (source of truth)
│   │
│   ├── types/                       # Plugin-wide types
│   │   ├── engine.ts                # EngineEvent, handler signatures
│   │   ├── content.ts               # CourseRow, LessonRow mirrors (read-only copies for typing)
│   │   └── storage.ts               # Enrollment, Progress, Quiz, QuizAttempt, Certificate, Cohort, etc.
│   │
│   ├── authz.ts                     # requireRole, requireInstructor, requireEnrolled, requireOwner
│   ├── kv-keys.ts                   # Centralized KV key prefixes (settings:*, state:*, handled:*, queue:*)
│   └── constants.ts                 # BOOTSTRAP_VERSION, defaults, enums
│
├── tests/                           # Vitest; structure per emdash convention (CLAUDE.md)
│   ├── unit/                        # Pure functions, no I/O
│   ├── integration/                 # Real in-memory SQLite + full plugin ctx
│   ├── e2e/                         # Playwright against emdash demo site
│   └── utils/
│       ├── test-plugin-ctx.ts       # Builds a real PluginContext against in-memory SQLite with the plugin installed
│       ├── seed.ts                  # User/enrollment/progress fixture helpers
│       └── time.ts                  # fakeNow() for drip/scheduling tests
│
└── CHANGELOG.md                     # emdash changeset convention
```

### 17.2 Dependency boundaries

```
                      index.ts (Vite)
                           │
                           ▼
                     constants.ts
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   sandbox-entry.ts  admin.tsx/*.tsx     blocks/*
          │                │
          ├─ routes/* ─────┼───────────────┐
          ├─ hooks/*       │               │
          ├─ reconcilers/* │               ▼
          │                │           api-client.ts
          ▼                │               │
       engine/*◄───────────┘               │
          ▲                                │
          │     (NEVER — admin does not    │
          │      import engine directly)   │
          └────────────────X───────────────┘
```

**Four hard rules enforced by lint/review:**

1. `engine/*` is pure business logic. No direct `fetch()`, no platform APIs — only `ctx.*`. Anything else goes through wrappers in `engine/email-queue.ts` or `setup/core-schema-client.ts`.
2. `admin/*` imports only `admin/api-client.ts` + `types/*` + React/Kumo. Never `engine/*`. Enforces D34 — the admin calls plugin routes like any other client.
3. `routes/*` is authz + input validation + engine call + response shape. No business logic inline; if a route is more than 20 lines, the logic belongs in the engine.
4. `setup/*` is the only module that talks to emdash core schema APIs directly (`/_emdash/api/schema/*`). It does this via `fetch()` using the admin's session cookie — never from plugin server code.

### 17.3 Initialization sequence

**Vite build (Astro config load):**
1. `astro.config.mjs` imports `lmsCore()` from `@emdash/lms-core`.
2. Factory returns the descriptor with `storage`, `capabilities`, `adminPages`, `adminWidgets`, `portableTextBlocks`, `settingsSchema`, `entrypoint: "@emdash/lms-core/sandbox"`, `admin.entry: "@emdash/lms-core/admin"`.
3. Emdash integration registers the plugin for runtime loading.

**Server boot (first request after deploy):**
1. Plugin manager (`packages/core/src/plugins/manager.ts`) resolves `sandbox-entry.ts`.
2. `definePlugin()` default export is read; `routes` and `hooks` are indexed.
3. `plugin:install` fires on first install only: seeds `settings:*` KV defaults, creates `state:bootstrap` with `completedSteps: []`. Admin sees a "Setup required" banner in the sidebar.
4. On subsequent boots: no-op; the plugin manager caches resolution per deploy.

**Per-request (any route hit):**
1. Emdash auth middleware runs (session cookie → `user` on `locals`).
2. Plugin route gets invoked with `{ input, request, requestMeta }` and `ctx`.
3. Route: (a) authz check via `authz.ts` helpers → (b) call into `engine/*` → (c) engine writes to storage, emits events synchronously, returns `Result<T>` → (d) route maps `Result` to ApiResponse envelope → (e) Response returned.
4. No global state touched. Each request is independent.

**Per cron tick:**
1. Emdash invokes the `cron` hook with `{ name, data?, scheduledAt }`.
2. `hooks/cron.ts` dispatches by `event.name`:
   - `issue-certificates` → `reconcilers/issue-certificates.ts`
   - `drip-release-reminders` → `reconcilers/drip-release-reminders.ts`
   - `flush-email-queue` → `reconcilers/flush-email-queue.ts`
3. Reconciler runs a bounded sweep (`limit: 100` per invocation) and exits. If work remains, next tick picks up where it left off.

### 17.4 Event bus mechanics

```ts
// engine/event-bus.ts (sketch)
type Handler<E extends EngineEvent> = (event: E, ctx: PluginContext) => Promise<void>;

const handlers = new Map<EngineEvent["name"], Array<{ id: string; fn: Handler<any> }>>();

export function on<E extends EngineEvent>(
  name: E["name"],
  handlerId: string,   // stable ID for idempotency key
  fn: Handler<E>,
) { /* register */ }

export async function emit(event: EngineEvent, ctx: PluginContext): Promise<void> {
  const list = handlers.get(event.name) ?? [];
  for (const { id, fn } of list) {
    const key = `handled:${id}:${event.key}`;
    if (await ctx.kv.get(key)) continue;                 // already handled
    try {
      await fn(event, ctx);
      await ctx.kv.set(key, { at: Date.now() });          // TTL via wrapper
    } catch (err) {
      if (event.critical) throw err;                      // propagate to route
      ctx.log.error("handler failed", { event: event.name, id, err });
      // best-effort: swallow, reconciler will retry
    }
  }
}
```

Handler registration happens once at module load (top-level `on(...)` calls in each engine module). No runtime registration, no per-request setup cost.

### 17.5 Result<T> pattern

```ts
// engine/result.ts
export type Result<T, E = { code: string; message: string }> =
  | { ok: true; data: T }
  | { ok: false; error: E };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const err = (code: string, message: string): Result<never> =>
  ({ ok: false, error: { code, message } });
```

All engine functions return `Result<T>`. Routes unwrap and map:

```ts
// routes/student.ts (sketch)
enroll: {
  input: z.object({ courseId: z.string(), cohortId: z.string().optional(), source: sourceEnum }),
  handler: async ({ input, request }, ctx) => {
    const user = await authz.requireRole(ctx, "SUBSCRIBER");
    if (!user.ok) return toApiError(user.error, 401);

    const result = await engine.enrollments.grant(ctx, user.data.id, input);
    if (!result.ok) return toApiError(result.error, mapStatus(result.error.code));
    return { success: true, data: { enrollmentId: result.data.id } };
  },
}
```

This keeps the throw/catch layer at the route boundary only — engine code never throws for expected errors (not-enrolled, enrollment-closed, quiz-timeout, etc.). Real exceptions (DB crash, programming bug) still bubble and get logged by the route's outer catch.

### 17.6 Error code taxonomy

All codes prefixed `LEARN_`, SCREAMING_SNAKE_CASE. Examples:

| Code | HTTP | Meaning |
|---|---|---|
| `LEARN_NOT_ENROLLED` | 403 | User is not enrolled in this course |
| `LEARN_ALREADY_ENROLLED` | 409 | Duplicate enrollment attempted |
| `LEARN_ENROLLMENT_CLOSED` | 403 | `enrollment_open=false` or outside window |
| `LEARN_COHORT_AT_CAPACITY` | 409 | Cohort capacity reached |
| `LEARN_LESSON_LOCKED` | 403 | Drip/sequential gate not satisfied |
| `LEARN_QUIZ_NOT_STARTED` | 404 | No matching attempt for submit |
| `LEARN_QUIZ_TIMEOUT` | 409 | Hard time-limit policy, submit refused |
| `LEARN_CERT_NOT_FOUND` | 404 | Public verification code invalid |
| `LEARN_COURSE_HAS_ENROLLMENTS` | 409 | Cannot delete course with active enrollments |
| `LEARN_SETUP_INCOMPLETE` | 409 | Plugin feature called before setup wizard finished |
| `LEARN_NOT_INSTRUCTOR` | 403 | User is not instructor of this course |

Admin UI maps codes to localized messages client-side (matches `.claude/CLAUDE.md` convention: "Server-side error messages still English-only; error codes stay stable; admin maps to localized messages").

### 17.7 Implementation phases

Ordered for a solo dev. Each phase is independently shippable/testable.

| # | Phase | Modules | Output |
|---|---|---|---|
| 1 | **Scaffold + wizard** (~week 1) | `constants`, `kv-keys`, `types/*`, `setup/*`, `hooks/install.ts`, minimal `index.ts` + `sandbox-entry.ts` + `SetupWizardPage.tsx` | Install plugin → wizard creates collections |
| 2 | **Engine core** (~weeks 2–3) | `engine/{result,event-bus,idempotency,enrollments,progress,curriculum,drip}`, `authz.ts`, `routes/student.ts` (partial) | Enroll → view curriculum → tick progress → complete lesson |
| 3 | **Quizzes** (~week 4) | `engine/quizzes`, quiz routes, `blocks/QuizBlock.tsx`, `QuizListPage` + `QuizAuthoringPage` | Author a quiz → embed in lesson → student takes it → graded |
| 4 | **Certificates + cohorts** (~week 5) | `engine/{certificates,cohorts,instructors}`, public routes, cohort/instructor admin pages | Course complete → cert issued → public verify works |
| 5 | **Hooks + reconcilers** (~week 6) | `hooks/{content,comment,cron}`, `reconcilers/*`, `engine/analytics.ts` (routes only per D33) | Deletion guards, drip reminders, cert reconciliation, email queue flush |
| 6 | **Admin UI** (~weeks 7–9) | `admin/{DashboardPage,CoursePage,EnrollmentsPanel,SettingsPage}` + shared components | Full instructor + admin surface |
| 7 | **Polish + docs** (~week 10) | README, integration example in demo site, changeset | Release-ready |

Target: ~10 weeks solo = matches L estimate in §14.

### 17.8 Conventions to standardize up-front

| Convention | Enforcement |
|---|---|
| All KV keys in `kv-keys.ts` as typed constants | No ad-hoc strings in engine code |
| All engine functions return `Result<T>` | Lint rule: engine modules can't export `async` functions returning raw `Promise<T>` |
| All user-facing strings via Lingui (`t\`...\``, `<Trans>`) | Per `.claude/CLAUDE.md` — CI fails on stale catalogs |
| All admin UI uses Kumo components + `ms-*`/`me-*` logical classes | Per `.claude/CLAUDE.md` — RTL-safe |
| All error responses via `apiError()` helper; never inline `new Response(JSON.stringify(...))` | Per `.claude/CLAUDE.md` emdash convention |
| No `console.log` — use `ctx.log.*` | Lint rule |
| Storage queries must use indexed fields only (plugin storage throws on non-indexed queries) | Runtime-enforced by emdash; adding an index requires descriptor change + reinstall |
| Tests use real in-memory SQLite via `better-sqlite3` + Kysely | Per `.claude/CLAUDE.md` — no mocked DBs |

---

## 18. Test strategy

### 18.1 Three layers, three purposes

| Layer | Where | Purpose | Runs against |
|---|---|---|---|
| **Unit** | `tests/unit/` | Pure functions, no I/O, no mocks | Plain function calls |
| **Integration** | `tests/integration/` | Engine + routes + hooks against real storage | In-memory SQLite + real `ctx` built by `test-plugin-ctx.ts` |
| **E2E** | `tests/e2e/` | Full admin + student flows through the emdash runtime | Playwright driving `demos/simple` with plugin installed |

Unit tests are fast (<50 ms per test) and catch most engine correctness bugs at zero infra cost. Integration tests catch storage/query/authz regressions — the class of bug that mocked-DB tests routinely miss. E2E tests catch only what neither lower layer can see: the setup wizard hitting emdash's schema API with the admin's real session, and the full student journey through real middleware.

### 18.2 Coverage targets (closes Q18)

| Scope | Line coverage | Rationale |
|---|---|---|
| `engine/*` | **≥85%** | Pure-ish, high ROI; business correctness lives here |
| `routes/*` | **≥80%** | Thin but authz bugs are security-critical |
| `hooks/*`, `reconcilers/*` | **≥80%** | Deletion guards + reconciliation correctness |
| `setup/*` | **≥70%** | Mostly scripted REST; aim for happy path + one failure per step |
| `admin/*`, `blocks/*` | **excluded from gate** | React UI, covered by E2E and manual |
| Overall package | derived, target ≥75% | Not a gate; a signal |

Coverage enforced via `vitest.config.ts` `coverage.thresholds` per directory. Fail the build if any explicit threshold drops below target.

### 18.3 Fixtures & utilities

**`tests/utils/test-plugin-ctx.ts`** — the core fixture. Builds a real `PluginContext`:

```ts
export async function createTestPluginCtx(opts?: {
  user?: Partial<UserInfo>;            // default: admin
  withCollections?: boolean;           // default: true — runs setup wizard steps
  fakeEmail?: true;                    // default: true — captures instead of sends
  fakeHttp?: Record<string, Response>; // URL → canned response
}): Promise<{ ctx: PluginContext; db: Kysely<Database>; outbox: EmailMessage[]; teardown: () => Promise<void> }>;
```

Under the hood: creates a fresh in-memory SQLite via emdash's `createTestDatabase()`, runs core migrations, runs the plugin's setup wizard steps against it, wires `ctx.kv` / `ctx.storage` / `ctx.content` / `ctx.log` / `ctx.cron` / `ctx.email` / `ctx.http` with test-safe implementations, returns.

**`tests/utils/seed.ts`** — fixture helpers:
```ts
seedCourse(ctx, { title, priceCents, enrollmentOpen })
seedLesson(ctx, { courseId, order, isPreview, requiresPrevious, dripOffsetDays })
seedStudent(ctx, { email, role? })
seedEnrollment(ctx, { userId, courseId, source? })
seedProgress(ctx, { userId, lessonId, percentComplete, completedAt? })
seedQuiz(ctx, { passingScore, questions })
```

**`tests/utils/time.ts`** — `fakeNow("2026-06-01T00:00:00Z")` wraps `Date.now()` + `new Date()` for the scope of a test. Required for drip-release and cert-expiry tests.

### 18.4 What to test at each layer

**Unit (pure, no ctx):**
- `engine/drip.ts`: `unlocksAt(enrollment, lesson, mode)` — all four combinations of (immediate/relative) × (scheduled_at set/unset).
- `engine/quizzes.ts::grade(attempt, quiz)` — multiple-choice, multi-select, true/false, short-text (case-insensitive match). Passing/failing at threshold, with `timeLimitPolicy="hard"` and `"soft"` branches.
- `engine/curriculum.ts::applyGates(lessons, progress, enrollment)` — returns visible lessons with `unlockedAt`. `requires_previous` gating. Preview lessons visible without enrollment.
- `engine/result.ts` — `ok`, `err`, `mapError`, `chain`.
- Error code string stability (snapshot test on `LEARN_*` enum).

**Integration (real ctx):**
- Every engine module with storage side-effects: enrollments, progress, quizzes, certificates, cohorts, instructors.
- Every route: happy path + 1–2 failure paths + authz-denied path. Input validation: send malformed body, assert 400.
- Hooks: `content:beforeDelete` refuses course with active enrollments; `comment:beforeCreate` denies non-enrolled user if gate enabled.
- Event bus: register two handlers for the same event, emit, assert both run exactly once; emit same key twice, assert handlers run once total.
- Reconcilers: seed a stale state (course complete, no cert row), run reconciler, assert cert row created + idempotency marker set.
- Email queue: set `ctx.email = undefined`, trigger flow, assert message in `queue:email:*`. Re-enable, run `flush-email-queue`, assert outbox received it.
- Setup wizard: seed empty DB, run each wizard step once, assert collections + fields exist; run every step again, assert zero writes (idempotency).

**E2E (Playwright, against `demos/simple`):**
- **Setup flow:** install plugin → dev bypass to admin → navigate to setup → click "Run setup" → assert Courses + Lessons visible in sidebar.
- **Student happy path:** create student via admin → sign in as student (dev bypass) → enroll → open lesson → tick progress → complete → assert cert in "my certificates" + `my-learning` dashboard.
- **Quiz path:** student starts quiz → submits correct answers → passes → triggers lesson complete → course complete → cert issued.
- **Drip gating:** seed a lesson with `drip_offset_days=7` → student enrolls today → assert lesson is locked → `fakeNow(+8d)` + reload curriculum → assert unlocked.
- **Uninstall:** uninstall with `deleteData=false` → reinstall → collections + enrollments intact. Uninstall with `deleteData=true` → collections + plugin storage gone.
- **Rename protection:** wizard creates `price_cents` → admin renames it to `price` via schema UI → re-run wizard → assert repair prompt appears (per §7).

Dev bypasses documented in `.claude/CLAUDE.md`:
- `GET /_emdash/api/setup/dev-bypass?redirect=/_emdash/admin` (first-time setup + admin session)
- `GET /_emdash/api/auth/dev-bypass?redirect=/_emdash/admin` (session only)

Both are 403 in `import.meta.env.PROD`.

### 18.5 Example test (unit)

```ts
// tests/unit/engine/drip.test.ts
import { describe, it, expect } from "vitest";
import { unlocksAt } from "../../../src/engine/drip.js";

describe("drip.unlocksAt", () => {
  const lesson = { id: "l1", dripOffsetDays: 7, scheduledAt: null };
  const enrollment = { enrolledAt: "2026-06-01T00:00:00Z" };

  it("immediate mode ignores drip_offset_days", () => {
    expect(unlocksAt(enrollment, lesson, "immediate")).toBe(enrollment.enrolledAt);
  });

  it("relative mode adds drip_offset_days to enrolledAt", () => {
    expect(unlocksAt(enrollment, lesson, "relative")).toBe("2026-06-08T00:00:00Z");
  });

  it("relative mode with 0 offset unlocks immediately", () => {
    expect(unlocksAt(enrollment, { ...lesson, dripOffsetDays: 0 }, "relative"))
      .toBe(enrollment.enrolledAt);
  });

  it("respects scheduled_at as a floor in both modes", () => {
    const scheduled = { ...lesson, scheduledAt: "2026-07-01T00:00:00Z" };
    expect(unlocksAt(enrollment, scheduled, "immediate")).toBe("2026-07-01T00:00:00Z");
    expect(unlocksAt(enrollment, scheduled, "relative")).toBe("2026-07-01T00:00:00Z");
  });
});
```

### 18.6 Example test (integration)

```ts
// tests/integration/engine/enrollments.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createTestPluginCtx } from "../../utils/test-plugin-ctx.js";
import { seedCourse, seedStudent } from "../../utils/seed.js";
import * as enrollments from "../../../src/engine/enrollments.js";

describe("enrollments.grant", () => {
  let fixture: Awaited<ReturnType<typeof createTestPluginCtx>>;
  afterEach(() => fixture?.teardown());

  it("creates a row and emits enrollment:created", async () => {
    fixture = await createTestPluginCtx();
    const { ctx, outbox } = fixture;
    const course = await seedCourse(ctx, { title: "React", enrollmentOpen: true });
    const student = await seedStudent(ctx, { email: "alice@example.com" });

    const result = await enrollments.grant(ctx, student.id, {
      courseId: course.id, source: "free",
    });

    expect(result.ok).toBe(true);
    const row = await ctx.storage.enrollments.query({
      where: { userId: student.id, courseId: course.id },
    });
    expect(row.items).toHaveLength(1);
    expect(outbox.at(-1)?.subject).toMatch(/Welcome/);
  });

  it("returns LEARN_ALREADY_ENROLLED on duplicate", async () => {
    // ...
  });

  it("returns LEARN_ENROLLMENT_CLOSED when enrollment_open=false", async () => {
    // ...
  });
});
```

### 18.7 Example test (E2E)

```ts
// tests/e2e/student-journey.spec.ts
import { test, expect } from "@playwright/test";

test("student completes a course end-to-end", async ({ page }) => {
  // Dev bypass to admin, seed a course + lesson + student
  await page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin");
  // ... admin seeds content via UI ...

  // Sign in as student
  await page.goto(`/_emdash/api/auth/dev-bypass?asUser=alice@example.com&redirect=/courses/react`);

  // Enroll
  await page.getByRole("button", { name: "Enroll" }).click();
  await expect(page.getByText("Enrolled")).toBeVisible();

  // Complete lesson
  await page.getByRole("link", { name: "Lesson 1" }).click();
  await page.getByRole("button", { name: "Mark complete" }).click();

  // Verify cert appears in my-learning
  await page.goto("/my-learning");
  await expect(page.getByText("🏆 Certificate")).toBeVisible();
});
```

### 18.8 What we deliberately don't test

- **React component rendering.** Snapshot tests on JSX are brittle and have low bug-catching ROI. Component behavior covered by E2E.
- **Kumo component internals.** Trust upstream.
- **Emdash core behavior.** Trust it; test only our integration points.
- **Visual regressions.** No Percy/Chromatic in v1. Revisit if design drift becomes a real problem post-ship.
- **Load tests.** Not in v1 CI. Manually benchmark before 1.0 against the scale target answer (Q5).

### 18.9 Flakiness rules

- **No real network in any test.** `ctx.http` replaced with a URL→Response map in `createTestPluginCtx`.
- **No real email.** `ctx.email` captures to an `outbox` array.
- **No wall clock in time-sensitive logic.** Use `fakeNow()`; CI sets `TZ=UTC` + pins `Intl.DateTimeFormat` locale.
- **Each test file gets its own in-memory DB** via `createTestPluginCtx` in `beforeEach`/`afterEach`. Vitest runs files in parallel safely.
- **No sleep/polling in E2E.** Playwright `expect(locator).toBeVisible()` auto-retries; `waitFor` instead of `waitForTimeout`.
- **Dev bypass URLs are the only way tests authenticate.** No cookie-baking, no test-only plugin backdoors.

### 18.10 CI gates (summary)

A PR cannot merge if any of these fail. Script names match T00's `package.json`.

1. `pnpm typecheck` — `tsc --noEmit`, clean
2. `pnpm lint:quick` — `oxlint -f json`, zero diagnostics (T00 uses oxlint, not eslint)
3. `pnpm format:check` — Prettier clean
4. `pnpm test` — runs `test:unit` + `test:integration` (both vitest)
5. `pnpm test:e2e` — Playwright green (wired to demo site per §20, §26 T26)
6. Coverage threshold — **not yet wired at T00**; added to `vitest.config.ts` as part of T04 (test infra) with per-directory thresholds from §18.2
7. Changeset present if any file under `src/**` changed (per emdash's `changesets` convention, adapted for the standalone repo)

T00 has not created `.github/workflows/ci.yml` yet — that lands in T27. Every gate above is runnable locally today.

---

## 19. For AI agents: reading order

This PRD assumes you (the building agent) have **also read emdash's plugin documentation** before writing code. Do not improvise plugin structure — emdash has a specific plugin model.

**Required reading (in order):**

1. This PRD sections §1–§4 (context, scope, architecture decisions).
2. `skills/creating-plugins/SKILL.md` in the emdash repo. Authoritative reference for `PluginDescriptor`, `definePlugin()`, hooks, routes, admin config, and the standard/native format split. **Do not invent types** — use the ones declared in `packages/core/src/plugins/types.ts`.
3. `skills/creating-plugins/references/storage.md` — plugin storage queries, indexes, pagination.
4. `skills/creating-plugins/references/hooks.md` — all hook signatures and semantics.
5. `skills/creating-plugins/references/admin-ui.md` — React admin entry format.
6. `skills/creating-plugins/references/portable-text-blocks.md` — PT block registration.
7. `packages/plugins/audit-log/` source — closest existing native plugin to crib from.
8. This PRD §5 onward for the Emdash Learn-specific schema, routes, engine, and task breakdown.

When generating code, prefer **reading types from the emdash source** (`packages/core/src/plugins/types.ts`, `packages/core/src/schema/types.ts`, `packages/auth/src/types.ts`) over paraphrasing them.

---

## 20. Local development setup

Emdash Learn ships as a **standalone repo** (D51). The developer flow:

### 20.1 Recommended local layout

Clone emdash and the plugin side-by-side:

```
~/dev/
├── emdash/                    # Clone of emdash for iterative development
└── lms-core/                  # This plugin (its own repo)
    ├── package.json           # @emdash/lms-core
    ├── src/
    ├── tests/
    └── demos/simple/          # Astro site that uses the plugin + emdash
```

### 20.2 Wiring the demo to the plugin source

**Default (T00 scaffold — recommended for most work):** use the published `emdash` from npm. The plugin's root `package.json` declares `"emdash": ">=0.5.0"` as a peer and devDependency; the demo's `package.json` depends on `"@emdash/lms-core": "workspace:*"` (pnpm links it automatically via the workspace declared in `pnpm-workspace.yaml`). No overrides needed. `pnpm install` just works.

**Optional — dev against emdash source** (only needed if you're debugging into emdash core or testing unreleased changes): add a pnpm override to the **root** `package.json` (not the demo's — pnpm ignores workspace-member overrides):

```jsonc
// <plugin-repo-root>/package.json
{
  "pnpm": {
    "overrides": {
      "emdash": "file:../emdash/packages/core"
    }
  }
}
```

Path is `../emdash/packages/core` relative to the plugin repo root — assumes emdash is cloned at `~/dev/emdash/` as a sibling of `~/dev/lms-core/` per §20.1.

No override is needed for `@emdash/lms-core` itself — the `workspace:*` protocol handles the link between the plugin root and `demos/simple/`.

### 20.3 Running the demo

```bash
# From the plugin repo root
pnpm install
pnpm build                            # tsdown → dist/ (first-run requirement before demo can resolve it)
pnpm --filter ./demos/simple dev      # starts Astro at http://localhost:4321
```

Then hit the dev-bypass URL to skip passkey setup:

```
http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin
```

This runs emdash migrations, creates a dev admin user (`dev@emdash.local`), and redirects to the admin. The plugin's Setup Wizard sidebar entry appears immediately.

**Note on seeding:** the demo's T00 `seed` script currently wraps `emdash seed` — that seeds emdash's own sample content, not Emdash Learn fixtures. The dedicated LMS seed script from §25 is produced by T26 (phase 7). Until then, click through the plugin's Setup Wizard manually after dev-bypass.

### 20.4 Fast iteration

- `pnpm dev` in the plugin root runs `tsdown --watch`, rebuilds `dist/` on change (script per T00's `package.json`).
- The demo's Astro dev server hot-reloads when the plugin's `dist/` changes.
- Tests: `pnpm test:watch` (vitest in watch mode) while editing engine code.
- Playwright E2E: `pnpm test:e2e --ui` for interactive debug (wired at T26).

### 20.5 Required emdash version

The plugin's `peerDependencies` declares a minimum emdash version. Set this to whatever's current at Phase 1 scaffold time and only bump when consuming new core features.

---

## 21. Phase acceptance criteria

Phases from §17.7, with crisp "done when" definitions so subagents know when to stop.

### Phase 1 — Scaffold + setup wizard

Done when all of these hold:
- `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm lint:quick`, `pnpm test` all pass from a clean checkout.
- `demos/simple/` boots, admin login via dev-bypass works, and the sidebar shows a "Setup" entry under the plugin.
- Clicking "Run setup" on the wizard page creates `courses` and `lessons` content collections with **every** frozen field (§5.1, §5.2), with no extra fields.
- Running the wizard a second time produces **zero writes** (all probes return "already done").
- Uninstalling the plugin with `deleteData: false` leaves the `ec_courses` and `ec_lessons` tables intact; with `deleteData: true` drops them.
- If an admin manually renames a 🔒 field between runs, the wizard surfaces a repair prompt (not silent recreation).

### Phase 2 — Engine core

Done when all of these hold:
- `engine/event-bus.ts` supports registering handlers, emitting events, and idempotency-gating via KV with 30-day TTL (D23).
- `engine.enrollments.grant/revoke/isEnrolled` all work; grant emits `enrollment:created`.
- `engine.progress.tick/markLessonComplete` work; `percentComplete ≥ 90` emits `lesson:completed`.
- `engine.curriculum.forUser` returns correctly gated lessons (drip, `requires_previous`, `is_preview`).
- `engine.drip.unlocksAt` unit tests cover all 4 combinations of (immediate/relative) × (scheduled/unscheduled).
- Student routes `enroll`, `curriculum`, `lesson`, `progress:tick`, `progress:complete`, `my-learning` all work end-to-end from the demo.
- Integration tests for each engine module exist, pass, and cover at least happy + 2 error paths.
- Coverage: `engine/*` ≥85%, `routes/*` ≥80% (D23, §18.2).

### Phase 3 — Quizzes

Done when all of these hold:
- `engine.quizzes.grade()` is a pure function with tests for MCQ, multi-select, true/false, short-text (case-insensitive).
- `quiz:start` and `quiz:submit` routes work; submit emits `quiz:attempted` and (if passed + terminal) `lesson:completed`.
- `timeLimitPolicy: "hard"` rejects submits past deadline (`LEARN_QUIZ_TIMEOUT`); `"soft"` accepts but records `overtime: true`.
- QuizBlock PT block can be inserted into a lesson body, renders in the editor, and renders on the frontend via `blocks/astro/index.ts`.
- Quiz authoring page (§16.5) can create, edit, and delete quizzes; preview mode runs an attempt against a scratch row.

### Phase 4 — Certificates + cohorts

Done when all of these hold:
- Course completion (all lessons complete) writes an `enrollments.completedAt` and an idempotent `certificates` row; emits `certificate:issued`.
- Certificate has a unique `verificationCode`; public `certificate:verify` returns minimum PII (user name, course title, issued date, revoked flag).
- Cohort CRUD + member add/remove works. Over-capacity tolerates 1–2 extras (D43).
- CSV import matches by email only, returns unknowns in the response (D50).
- Instructor assignments: `assign`/`unassign`/`isInstructorOf` work; uniqueness on `(courseId, userId)`.

### Phase 5 — Hooks + reconcilers

Done when all of these hold:
- `content:beforeDelete` on `courses` refuses if any non-revoked enrollment exists.
- `content:beforeDelete` on `lessons` refuses if any `progress` row references it.
- `comment:beforeCreate` (when the lesson-gate setting is on) denies non-enrolled commenters.
- Cron hook dispatches to three reconcilers by event name. Each reconciler:
  - `issue-certificates`: backfills missing certs and auto-submits stuck quiz attempts; idempotent.
  - `drip-release-reminders`: emails users once per (user, lesson) release window; guarded by `kv "notified:${lessonId}:${userId}"`.
  - `flush-email-queue`: drains `queue:email:*` when `ctx.email` is defined; marks flushed items.
- Analytics queries (`engine/analytics.ts`) return correct shapes for all routes in §16.10; no UI built yet per D33.

### Phase 6 — Admin UI

Done when all of these hold:
- Every page in §16 is implemented in React via `admin.entry`, using Kumo components only.
- `admin/api-client.ts` wraps every plugin route with typed inputs/outputs; all errors surface via `throwResponseError`/`DialogError` (per `.claude/CLAUDE.md`).
- All user-facing strings go through Lingui; `pnpm locale:extract` produces no diff on clean run.
- Admin passes manual RTL check in an Arabic locale (switch locale in admin; walk every page).
- `/analytics` route is NOT built (D33 defers the UI); its sidebar entry is absent.
- Instructor-scoped pages correctly hide pages/rows that don't belong to the signed-in instructor.

### Phase 7 — Polish + release

Done when all of these hold:
- Demo site (`demos/simple/`) has learner-facing pages wired: catalog, course detail, lesson player, quiz taker, my-learning dashboard, certificate display, certificate verify.
- Seed script (§25) produces realistic data; running it twice is idempotent.
- E2E tests from §18.7 all pass in CI.
- README written, CHANGELOG initial entry in place (per §27), CI configured (§18.10), LICENSE (MIT) committed.
- `pnpm build` produces a publishable ESM + DTS artifact.

---

## 22. Engine function signatures

Pin these before implementation to prevent two subagents inventing conflicting shapes. Every function returns `Result<T>` (D35) unless marked "pure" (which throws are value-returning).

```ts
// engine/result.ts
export type Result<T, E = { code: string; message: string }> =
  | { ok: true; data: T }
  | { ok: false; error: E };
export const ok = <T>(data: T): Result<T>;
export const err = (code: string, message: string): Result<never>;

// engine/event-bus.ts
export function on<E extends EngineEvent>(
  name: E["name"], handlerId: string, fn: (event: E, ctx: PluginContext) => Promise<void>
): void;
export async function emit(event: EngineEvent, ctx: PluginContext): Promise<void>;

// engine/idempotency.ts
export async function wasHandled(ctx: PluginContext, handlerId: string, key: string): Promise<boolean>;
export async function markHandled(ctx: PluginContext, handlerId: string, key: string): Promise<void>;

// engine/enrollments.ts
export async function grant(ctx, userId: string, input: {
  courseId: string; cohortId?: string; source: EnrollmentSource; orderId?: string;
}): Promise<Result<Enrollment>>;
export async function revoke(ctx, enrollmentId: string, reason?: string): Promise<Result<Enrollment>>;
export async function listByUser(ctx, userId: string, opts?: { status?: "active"|"completed"|"all"; cursor?: string; limit?: number }): Promise<Result<PaginatedResult<Enrollment>>>;
export async function listByCourse(ctx, courseId: string, opts?: { status?: string; cursor?: string; limit?: number }): Promise<Result<PaginatedResult<Enrollment>>>;
export async function isEnrolled(ctx, userId: string, courseId: string): Promise<boolean>;

// engine/progress.ts
export async function tick(ctx, userId: string, input: {
  lessonId: string; positionSeconds: number; percentComplete: number;
}): Promise<Result<Progress>>;
export async function markLessonComplete(ctx, userId: string, lessonId: string): Promise<Result<{ courseComplete: boolean }>>;
export async function getForUser(ctx, userId: string, courseId: string): Promise<Result<Progress[]>>;
export async function evaluateCourseComplete(ctx, userId: string, courseId: string): Promise<Result<boolean>>;

// engine/curriculum.ts
export async function forUser(ctx, userId: string, courseId: string): Promise<Result<VisibleLesson[]>>;

// engine/drip.ts  (pure)
export function unlocksAt(enrollment: Enrollment, lesson: Lesson, mode: "immediate" | "relative"): string;

// engine/quizzes.ts
export async function create(ctx, input: QuizInput): Promise<Result<Quiz>>;
export async function update(ctx, quizId: string, patch: Partial<QuizInput>): Promise<Result<Quiz>>;
export async function remove(ctx, quizId: string): Promise<Result<void>>;
export async function list(ctx, opts?: { cursor?: string; limit?: number }): Promise<Result<PaginatedResult<Quiz>>>;
export async function startAttempt(ctx, userId: string, quizId: string, lessonId?: string): Promise<Result<{ attemptId: string; questions: QuestionForStudent[]; startedAt: string; timeLimit?: number }>>;
export async function submitAttempt(ctx, attemptId: string, answers: SubmittedAnswer[]): Promise<Result<{ score: number; passed: boolean; feedback: QuestionFeedback[] }>>;
export function grade(attempt: QuizAttempt, quiz: Quiz, now: Date): {
  score: number; passed: boolean; feedback: QuestionFeedback[]; overtime: boolean;
};  // pure

// engine/certificates.ts
export async function issue(ctx, userId: string, courseId: string): Promise<Result<Certificate>>;
export async function listForUser(ctx, userId: string, opts?: { cursor?: string; limit?: number }): Promise<Result<PaginatedResult<Certificate>>>;
export async function verify(ctx, code: string): Promise<Result<VerificationResult>>;
export async function revoke(ctx, certId: string, reason?: string): Promise<Result<Certificate>>;

// engine/cohorts.ts
export async function create(ctx, input: CohortInput): Promise<Result<Cohort>>;
export async function list(ctx, opts?): Promise<Result<PaginatedResult<Cohort>>>;
export async function get(ctx, cohortId: string): Promise<Result<{ cohort: Cohort; members: CohortMember[] }>>;
export async function addMember(ctx, cohortId: string, userId: string, role?: "student"|"ta"): Promise<Result<CohortMember>>;
export async function removeMember(ctx, cohortId: string, userId: string): Promise<Result<void>>;
export async function importFromEmails(ctx, cohortId: string, emails: string[]): Promise<Result<{ added: CohortMember[]; unknownEmails: string[] }>>;

// engine/instructors.ts
export async function assign(ctx, courseId: string, userId: string, role: "lead"|"co"|"ta"): Promise<Result<CourseInstructor>>;
export async function unassign(ctx, courseId: string, userId: string): Promise<Result<void>>;
export async function listForCourse(ctx, courseId: string): Promise<Result<CourseInstructor[]>>;
export async function listForUser(ctx, userId: string): Promise<Result<CourseInstructor[]>>;
export async function isInstructorOf(ctx, userId: string, courseId: string): Promise<boolean>;

// engine/analytics.ts
export async function dashboardStats(ctx, instructorId: string): Promise<Result<DashboardStats>>;
export async function dashboardCourses(ctx, instructorId: string): Promise<Result<CourseSummary[]>>;
export async function recentActivity(ctx, instructorId: string, limit: number): Promise<Result<ActivityItem[]>>;
export async function courseOverview(ctx, courseId: string): Promise<Result<CourseOverview>>;
export async function courseEnrollmentsTimeline(ctx, courseId: string, days: number): Promise<Result<{ date: string; count: number }[]>>;
export async function courseCompletionFunnel(ctx, courseId: string): Promise<Result<{ started: number; q25: number; q50: number; q75: number; completed: number }>>;
export async function courseProgressMatrix(ctx, courseId: string, opts?: { cursor?: string; limit?: number }): Promise<Result<{ students: Array<{ userId: string; name: string; lessonProgress: Record<string, number> }>; nextCursor?: string }>>;
export async function courseQuizStats(ctx, courseId: string): Promise<Result<QuizStats[]>>;
export async function studentProgressAcrossCourses(ctx, instructorId: string, studentId: string): Promise<Result<StudentProgress>>;
export async function siteAnalytics(ctx, range: DateRange): Promise<Result<SiteAnalytics>>;
export async function coursesComparison(ctx, range: DateRange, opts?): Promise<Result<PaginatedResult<CourseComparison>>>;
export async function engagementMetrics(ctx, range: DateRange): Promise<Result<EngagementMetrics>>;

// engine/email-queue.ts
export async function send(ctx, message: EmailMessage): Promise<Result<void>>;  // queues if no provider
export async function flush(ctx): Promise<Result<{ sent: number; remaining: number }>>;
```

Types like `EnrollmentSource`, `VisibleLesson`, `QuestionForStudent`, `DashboardStats`, `CourseOverview`, etc., are declared in `src/types/*.ts` and should be treated as authoritative once Phase 2's `T03` lands.

---

## 23. Route input schemas (Zod sketches)

Put these in `src/routes/schemas.ts` so they can be imported by both routes and tests.

```ts
import { z } from "astro/zod";

// Common
export const paginationInput = z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() });
export const enrollmentSource = z.enum(["free", "purchase", "invite", "admin"]);

// Student routes
export const enrollInput = z.object({
  courseId: z.string().min(1),
  cohortId: z.string().optional(),
  source: enrollmentSource,
  orderId: z.string().optional(),
});
export const unenrollInput = z.object({ enrollmentId: z.string().min(1), reason: z.string().max(500).optional() });
export const curriculumInput = z.object({ courseId: z.string().min(1) });
export const lessonInput = z.object({ lessonId: z.string().min(1) });
export const progressTickInput = z.object({
  lessonId: z.string().min(1),
  positionSeconds: z.number().int().min(0),
  percentComplete: z.number().min(0).max(100),
});
export const progressCompleteInput = z.object({ lessonId: z.string().min(1) });
export const quizStartInput = z.object({ quizId: z.string().min(1), lessonId: z.string().optional() });
export const quizSubmitInput = z.object({
  attemptId: z.string().min(1),
  answers: z.array(z.object({
    questionId: z.string().min(1),
    answer: z.union([z.string(), z.array(z.string()), z.boolean()]),
  })).min(1),
});
export const certificatesMineInput = paginationInput;
export const myLearningInput = paginationInput.extend({
  status: z.enum(["active", "completed", "all"]).optional(),
});

// Public routes
export const catalogInput = paginationInput.extend({
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  search: z.string().max(200).optional(),
});
export const certificateVerifyInput = z.object({ code: z.string().min(1).max(64) });

// Instructor routes — quiz
export const quizQuestion = z.object({
  id: z.string(),
  type: z.enum(["mcq", "multi", "true_false", "short_text"]),
  prompt: z.string().min(1),
  options: z.array(z.object({ id: z.string(), text: z.string(), correct: z.boolean() })).optional(),
  explanation: z.string().optional(),
  points: z.number().int().min(0).default(1),
});
export const quizCreateInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  passingScore: z.number().int().min(0).max(100),
  timeLimit: z.number().int().min(1).optional(),
  timeLimitPolicy: z.enum(["hard", "soft"]).default("hard"),
  randomize: z.boolean().default(false),
  questions: z.array(quizQuestion).min(1),
});

// Instructor routes — cohort
export const cohortCreateInput = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(63),
  title: z.string().min(1).max(200),
  startAt: z.string().datetime().optional(),
  endAt: z.string().datetime().optional(),
  capacity: z.number().int().min(1).optional(),
});
export const cohortImportInput = z.object({
  cohortId: z.string().min(1),
  emails: z.array(z.string().email()).min(1).max(500),
});

// Admin routes
export const settingsUpdateInput = z.object({
  defaultPassingScore: z.number().int().min(0).max(100).optional(),
  certificateExpiryDays: z.number().int().min(0).nullable().optional(),
  dripMode: z.enum(["immediate", "relative"]).optional(),
  commentGateRequiresEnrollment: z.boolean().optional(),
  // Secrets never appear on GET; only write-only via update
});
```

The remaining routes (instructor dashboard reads, course stats, exports, etc.) take simple inputs (`{ courseId }`, `{ userId }`, pagination) and can be defined inline at implementation time.

---

## 24. Conventions & gotchas reference card

Pin this at the top of the plugin-level `CLAUDE.md`. One-line rules with links into the PRD or the emdash repo.

| # | Rule | Source |
|---|---|---|
| 1 | All internal TypeScript imports use `.js` extension (ESM requirement) | emdash `.claude/CLAUDE.md` |
| 2 | All type-only imports use `import type` (`verbatimModuleSyntax: true`) | emdash `.claude/CLAUDE.md` |
| 3 | Use `import.meta.env.DEV`, not `process.env.NODE_ENV` | emdash `.claude/CLAUDE.md` |
| 4 | All user-facing strings via Lingui (`t\`...\`` or `<Trans>`); run `pnpm locale:extract` + `compile` after changes | emdash `.claude/CLAUDE.md`, §16 |
| 5 | Admin margins/padding use logical classes (`ms-*`/`me-*`/`ps-*`/`pe-*`/`start-*`/`end-*`), never `ml-*`/`mr-*` | emdash `.claude/CLAUDE.md`, §16 |
| 6 | Admin UI uses Kumo components only; no raw buttons, no other UI libraries | emdash `.claude/CLAUDE.md`, §16 |
| 7 | Never use `console.log`; use `ctx.log.*` | §17.8 |
| 8 | Tests use real in-memory SQLite via `better-sqlite3`; never mock the DB | emdash `.claude/CLAUDE.md`, §18 |
| 9 | Plugin storage queries must use indexed fields; adding an index requires descriptor change + reinstall | `skills/creating-plugins/references/storage.md`, §5.3 |
| 10 | Never interpolate values into SQL; Kysely parameterizes automatically | emdash `.claude/CLAUDE.md` |
| 11 | Admin UI never imports from `engine/*`; it calls plugin routes via `api-client.ts` (D34) | §17.2, D34 |
| 12 | All engine functions return `Result<T>` (D35); routes unwrap at the boundary | §17.5, D35 |
| 13 | All error codes `SCREAMING_SNAKE_CASE` with `LEARN_` prefix (D36) | §17.6, D36 |
| 14 | Content write input routes SEO fields through the reserved `seo` key | emdash `packages/core/src/plugins/types.ts:237` |
| 15 | Secrets in admin settings use Kumo `secret` field type (write-only) | §16.8, D29 |
| 16 | Changeset required per behavior-affecting PR | emdash `.claude/CLAUDE.md` |
| 17 | Never rename or retype a 🔒 field; add a new field and deprecate | §4.4, §7 |
| 18 | Descriptor declares `capabilities`, `allowedHosts`, `storage`, `adminPages`, `settingsSchema`, `portableTextBlocks` — all at Vite build time | `skills/creating-plugins/SKILL.md`, §17.3 |
| 19 | Setup-wizard POSTs to `/_emdash/api/schema/*` only from admin browser session; never from plugin server code | §4.2, §17.2 |
| 20 | Idempotency keys `handled:${handlerId}:${eventKey}` have 30-day TTL | D23, §17.4 |

---

## 25. Seed data spec

Script: `demos/simple/scripts/seed-lms.ts`. Run with `pnpm --filter ./demos/simple seed`. Idempotent: re-running clears existing plugin storage + re-creates fixture rows.

**Content (via emdash's content API):**

- **Course A — "Getting Started with React"** (free, published, enrollment open)
  - 6 lessons: intro (preview), setup, components, state, effects, deploy (last one has `requires_previous: true`)
  - Lesson 3 has a terminal quiz attached
  - Duration total: ~3 hours (sum of lesson `duration_seconds`)
- **Course B — "Advanced SQL"** (paid display `$49 USD`, published, `enrollment_open: true`, drip mode `relative` with offsets 0/7/14/21 days)
  - 4 lessons, all sequential
  - No quizzes
- **Course C — "Shipping Soon Course"** (draft status, `enrollment_open: false`) — tests edge case of locked enrollment
- **Course D — "Scheduled Drop"** (published, `enrollment_open: true`, first lesson `scheduled_at` = now+1h) — tests drip-scheduled reveal

**Users:**

- `admin@emdash.local` (ADMIN) — default dev-bypass user
- `maya@instructor.local` (EDITOR) — instructor
- `ben@instructor.local` (EDITOR) — second instructor (co-teacher)
- `alice@student.local` (SUBSCRIBER) — enrolled in Course A, 68% progress
- `jon@student.local` (SUBSCRIBER) — enrolled in Course A and B, 0% and 12% respectively
- `lin@student.local` (SUBSCRIBER) — enrolled in Course A, completed, has certificate

**Plugin storage:**

- `course_instructors`: Maya is `lead` on A and B; Ben is `co` on A; Maya is `lead` on C.
- `enrollments`: as listed above.
- `progress`: Alice completed lessons 1–4 of Course A; Jon has `percentComplete: 45` on Course B lesson 1; Lin has all Course A lessons completed.
- `certificates`: one row for Lin + Course A, with valid `verificationCode`.
- `cohorts`: one cohort `spring-2026` with Alice and Jon as `student` members.
- `quizzes`: one quiz (4 MCQ questions, `passingScore: 70`, `timeLimit: 600`, `timeLimitPolicy: "hard"`), attached to Lesson 3 of Course A.
- `quiz_attempts`: one passing attempt by Lin; one failing attempt by Alice (`score: 45`).

Seed runs in a single `pnpm tsx` invocation; total time <5s. Reports a summary: "Seeded 4 courses, 14 lessons, 5 users, 5 enrollments, 1 quiz, 2 attempts, 1 certificate."

---

## 26. AI agent task breakdown

Critical for execution: this section decomposes the work into **27 self-contained units** that a Claude session can dispatch to subagents. Each task is scoped so two agents cannot conflict if run in parallel within the same wave.

**How to use this section:** the orchestrating Claude session reads §26, creates a task list (TodoWrite), and spawns subagents for any wave where multiple tasks are independent. Do **not** spawn subagents across waves — each wave blocks on the previous.

**Conventions for subagent prompts:**
- Always reference the PRD section(s) listed under "Read."
- Always reference the emdash source paths listed under "Emdash docs."
- Deliverables lists are authoritative — don't add files outside the list without updating the PRD.
- Acceptance criteria are CI-enforceable or manually verifiable. Every task ends with a passing local test run.

### Wave 0 — Bootstrap (1 task, sequential)

| ID | Title | Prereq | Size |
|---|---|---|---|
| **T00** | Scaffold plugin repo | none | S |

**T00 Deliverables:** `package.json` (name `@emdash/lms-core`, exports `.`/`./sandbox`/`./admin`/`./astro`, peer-deps emdash + astro + react, scripts for build/test/lint/format), `tsconfig.json` (ES2022, strict, `verbatimModuleSyntax: true`), `vitest.config.ts`, `playwright.config.ts`, `.prettierrc`, `.oxlintrc.json`, `pnpm-workspace.yaml` (lists `demos/*`), `README.md` (stub), `LICENSE` (MIT), empty `src/`, `tests/unit/`, `tests/integration/`, `tests/e2e/`, `demos/simple/` Astro skeleton with `astro.config.mjs` importing the plugin.
**T00 Read:** §19, §20, §17.1.
**T00 Emdash docs:** `skills/creating-plugins/SKILL.md`, `packages/plugins/audit-log/package.json` as reference.
**T00 Acceptance:** §21 Phase 1 preconditions — `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test` all pass; demo boots; plugin sidebar entry appears (empty).

### Wave 1 — Core skeleton (1 task, after T00)

| ID | Title | Prereq | Size |
|---|---|---|---|
| **T01** | Descriptor + sandbox entry + setup wizard | T00 | M |

**T01 Deliverables:** `src/index.ts` (full descriptor with capabilities, allowedHosts: [], storage shapes, adminPages, settingsSchema, portableTextBlocks stub for QuizBlock, componentsEntry), `src/sandbox-entry.ts` (definePlugin with plugin:install seeding defaults), `src/constants.ts` (BOOTSTRAP_VERSION=1, defaults), `src/kv-keys.ts`, `src/types/{storage,content,engine}.ts` (all storage + content shapes), `src/setup/{steps,core-schema-client,schema-fixtures}.ts`, `src/admin.tsx` (exports `SetupWizardPage` only at first), `src/admin/SetupWizardPage.tsx` with Block Kit-style checklist wired to wizard steps.
**T01 Read:** §5.1, §5.2, §5.3 (storage declarations), §7 (wizard), §17.1, §17.3.
**T01 Emdash docs:** `skills/creating-plugins/references/admin-ui.md`, `packages/core/src/astro/routes/api/schema/` for the exact endpoint shapes.
**T01 Acceptance:** §21 Phase 1 full.

### Wave 2 — Engine infrastructure (3 parallel tasks, after T01)

| ID | Title | Prereq | Parallel with | Size |
|---|---|---|---|---|
| **T02** | Result + event bus + idempotency + email queue | T01 | T03, T04 | M |
| **T03** | authz + base storage/content types | T01 | T02, T04 | S |
| **T04** | Test infrastructure (`createTestPluginCtx`, seed helpers, fakeNow) | T01 | T02, T03 | M |

**T02 Deliverables:** `src/engine/{result,event-bus,idempotency,email-queue}.ts` + unit tests in `tests/unit/engine/`.
**T02 Read:** §17.4, §17.5, §8.1, §8.3, D23.
**T02 Acceptance:** Unit tests cover Result helpers; register → emit → assert single handler run; emit twice with same key, assert handler runs once; email-queue queues when `ctx.email` undefined, flushes when defined.

**T03 Deliverables:** `src/authz.ts` (requireRole, requireInstructor, requireEnrolled, requireOwner — all return Result), full `src/types/storage.ts` + `src/types/content.ts` mirroring §5.
**T03 Read:** §5.3, §17.6, §2 roles table.
**T03 Acceptance:** Unit tests for each authz helper cover allow + deny + no-user cases; all `LEARN_*` codes present in `src/constants.ts`.

**T04 Deliverables:** `tests/utils/{test-plugin-ctx,seed,time}.ts`.
**T04 Read:** §18.3, `.claude/CLAUDE.md` testing section.
**T04 Emdash docs:** `packages/core/tests/utils/test-db.ts` — reuse patterns.
**T04 Acceptance:** A minimal test in `tests/integration/utils/self-test.ts` creates a ctx, seeds a user + course, tears down cleanly.

### Wave 3 — Feature engines (parallel-safe via per-feature route files)

**Route file ownership rule (see §17.1 routes/ subtree):** to eliminate write conflicts during parallel execution, each Wave 3 task owns its own route file. Each file exports a named `*Routes` object; `src/sandbox-entry.ts` composes them into the plugin descriptor's `routes` field as the final step of the wave.

| ID | Title | Prereq | Parallel with | Size |
|---|---|---|---|---|
| **T05** | Enrollments engine + routes | T02, T03, T04 | T06, T08, T10, T11 | M |
| **T06** | Progress engine + routes | T02, T03, T04 | T05, T08, T10, T11 | M |
| **T07** | Curriculum + drip + my-learning | T05, T06 | T09 | M |
| **T08** | Quiz engine + routes + grading | T02, T03, T04 | T05, T06, T10, T11 | L |
| **T09** | Certificates engine + routes | T06 | T07 | M |
| **T10** | Cohorts engine + routes | T02, T03, T04 | T05, T06, T08, T11 | M |
| **T11** | Instructors engine + routes | T02, T03, T04 | T05, T06, T08, T10 | S |

Sub-waves:
- **3a** (5 parallel after Wave 2): T05, T06, T08, T10, T11.
- **3b** (2 parallel after sub-wave 3a): T07, T09.

**T05** — `src/engine/enrollments.ts` + `src/routes/student-enrollments.ts` (exports `enrollmentRoutes`: `enroll`, `unenroll`) + tests. Reads §22, §23, §5.3 enrollments, §6.1, §8.2. Acceptance: §21 Phase 2 enrollments bullet.

**T06** — `src/engine/progress.ts` + `src/routes/student-progress.ts` (exports `progressRoutes`: `progress:tick`, `progress:complete`) + tests. `progress:tick` emits `lesson:completed` at ≥90%. Reads §22, §23, §5.3 progress, §6.1, §8.2.

**T07** — `src/engine/curriculum.ts` + `src/engine/drip.ts` + `src/routes/student-curriculum.ts` (exports `curriculumRoutes`: `curriculum`, `lesson`, `my-learning`) + tests. Drip unit tests required (all 4 combinations of immediate/relative × scheduled/unscheduled). Reads §22, §23, §5.2, §6.1, §17.3.

**T08** — `src/engine/quizzes.ts` + `src/routes/quizzes.ts` (exports `quizRoutes`: `quiz:start`, `quiz:submit`, `quiz:create`, `quiz:update`, `quiz:list`, `quiz:delete`) + tests. `grade()` is a pure function tested for all 4 question types + hard/soft time-limit policies. Reads §22, §23, §5.3 quizzes + quiz_attempts, §6.1 quiz:*, §6.3 quiz:create/update/list/delete.

**T09** — `src/engine/certificates.ts` + `src/routes/student-certificates.ts` (exports `certificateRoutesStudent`: `certificates:mine`) + `src/routes/public-certificates.ts` (exports `certificateRoutesPublic`: `certificate:verify`, rate-limited via KV) + tests. No PDF rendering (D32). Reads §22, §23, §5.3 certificates, §6.1 certificates:mine, §6.2 certificate:verify.

**T10** — `src/engine/cohorts.ts` + `src/routes/instructor-cohorts.ts` (exports `cohortRoutes`: `cohort:create`, `cohort:list`, `cohort:add-member`, `cohort:remove-member`, `cohort:import`) + tests. Capacity tolerates 1–2 overage (D43); CSV import matches by email only (D50). Reads §22, §23, §5.3 cohorts + cohort_members, §6.3 cohort:*.

**T11** — `src/engine/instructors.ts` + `src/routes/instructor-assignments.ts` (exports `instructorAssignmentRoutes`: `instructor:set`, `instructor:unset`) + tests. `engine/instructors.ts` also exports `listForCourse`, `listForUser`, `isInstructorOf` per §22 (consumed by authz and later tasks). Reads §22, §24, §5.3 course_instructors, §6.3 instructor:set.

**Wave 3 compose step (not a subagent task — the orchestrator does this manually after T07/T09 merge):** update `src/sandbox-entry.ts` to import every `*Routes` object above and spread them into `definePlugin({ routes: { ...enrollmentRoutes, ...progressRoutes, ...curriculumRoutes, ...quizRoutes, ...certificateRoutesStudent, ...certificateRoutesPublic, ...cohortRoutes, ...instructorAssignmentRoutes } })`. Verify in the demo before advancing to Wave 4.

### Wave 4 — Hooks + reconcilers + analytics (4 parallel tasks, after Wave 3)

| ID | Title | Prereq | Size |
|---|---|---|---|
| **T12** | Content hooks (deletion guards) | T05, T06, T10, T11 | S |
| **T13** | Comment hook (enrollment gate) | T05 | S |
| **T14** | Cron dispatch + 3 reconcilers | T09, T07, T02 | M |
| **T15** | Analytics engine (backend only per D33) | T05, T06, T08, T09 | L |

T12: `src/hooks/content.ts` + tests. Refuse delete if dependents exist. Acceptance: §21 Phase 5 content hooks.

T13: `src/hooks/comment.ts` + tests. Respect `commentGateRequiresEnrollment` setting.

T14: `src/hooks/cron.ts` + `src/reconcilers/{issue-certificates,drip-release-reminders,flush-email-queue}.ts` + tests. Each reconciler bounded + idempotent. Acceptance: §21 Phase 5 crons.

T15: `src/engine/analytics.ts` + `src/routes/instructor-analytics.ts` (exports `instructorAnalyticsRoutes` — dashboard/course/student queries per §16.10) + `src/routes/admin-analytics.ts` (exports `adminAnalyticsRoutes` — backend for deferred v2 UI per D33). All 16 analytics/instructor-reads routes from §16.10 implemented. No UI per D33. Acceptance: all routes return correct shapes against seeded data. After merge, append the two new route modules to the compose step in `src/sandbox-entry.ts`.

### Wave 5 — Blocks + public routes (2 parallel tasks, after Wave 3)

| ID | Title | Prereq | Size |
|---|---|---|---|
| **T16** | QuizBlock Portable Text block + site rendering | T08 | M |
| **T17** | Public routes (catalog + certificate:verify) | T05, T06, T09 | S |

T16: `src/blocks/QuizBlock.tsx` (admin-side, React) + `src/astro/index.ts` (frontend block component). Slash command registration in descriptor. Acceptance: admin can insert quiz block; frontend renders it; saved to PT JSON; §21 Phase 3 QuizBlock bullet.

T17: `src/routes/public-catalog.ts` (exports `catalogRoutes`: `catalog` — only `status=published` courses, price/currency in response). Note: `certificate:verify` + its KV-based rate limit ship with T09 in `src/routes/public-certificates.ts`. After T17 merges, append `catalogRoutes` to the compose step in `src/sandbox-entry.ts`.

### Wave 6 — Admin UI (8 parallel tasks, after Wave 4)

All rely on `src/admin/api-client.ts`, which T18 provides.

| ID | Title | Prereq | Size |
|---|---|---|---|
| **T18** | Admin api-client | T15 | M |
| **T19** | Dashboard page (§16.2) | T18 | M |
| **T20** | Course detail + 7 tabs (§16.3) | T18 | L |
| **T21** | Quiz list + authoring pages (§16.5) | T18 | L |
| **T22** | Cohort list + detail pages (§16.6) | T18 | M |
| **T23** | Instructors page (§16.9) | T18 | S |
| **T24** | Settings page (§16.8) | T18 | M |
| **T25** | Per-student progress view (§16.10a) | T18 | S |

T18: `src/admin/api-client.ts` typed over all plugin routes; error mapping; Lingui-ready.

T19–T25: one React page each. Each uses Kumo components, logical classes, Lingui. See §16 for exact layouts. Acceptance: §21 Phase 6.

### Wave 7 — Polish & release (2 sequential tasks, after all others)

| ID | Title | Prereq | Size |
|---|---|---|---|
| **T26** | Demo site wired + seed script | all prior | M |
| **T27** | README + CHANGELOG + CI + changeset | T26 | S |

T26: `demos/simple/src/pages/` with catalog, course-detail, lesson-player, quiz-taker, my-learning, cert-display, cert-verify. `demos/simple/scripts/seed-lms.ts` per §25. E2E tests (§18.7) run and pass.

T27: `README.md` (full — install, quick start, architecture, links), `CHANGELOG.md` (entry from §27), `.github/workflows/ci.yml` (per §18.10 gates), CONTRIBUTING.md, a `.changeset/` directory with the initial changeset.

### Parallelization summary

| Wave | Tasks | Parallelizable? | Est. wall-clock (solo w/ subagents) |
|---|---|---|---|
| 0 | T00 | no | 0.5 day |
| 1 | T01 | no | 2 days |
| 2 | T02, T03, T04 | **yes (3 parallel)** | 2 days |
| 3 | T05–T11 | **yes (7 parallel)** | 3 days |
| 4 | T12–T15 | **yes (4 parallel)** | 2 days |
| 5 | T16, T17 | **yes (2 parallel)** | 2 days |
| 6 | T18 then T19–T25 | T19–T25 yes (7 parallel after T18) | 4 days |
| 7 | T26 then T27 | sequential | 2 days |
| **Total** | **27 tasks** | | **~18 working days with subagents** (vs ~10 weeks solo in §17.7) |

Parallel execution via subagents compresses the timeline by ~3–4×. The critical path is still T00 → T01 → T02 → T03–T15 longest chain. Subagents cannot shortcut Phase 1; they pay off most in Waves 3 and 6 where tasks are genuinely independent.

---

## 27. Expected initial CHANGELOG

Write this as the first changeset entry in the plugin repo's `.changeset/` directory (or `CHANGELOG.md` top entry if not using changesets in the standalone repo — see T27).

```markdown
---
"@emdash/lms-core": major
---

Introduces **Emdash Learn**, an open-source LMS plugin for emdash.

**Content:**
- `courses` and `lessons` content collections with rich Portable Text bodies, drafts, revisions, scheduling, SEO, and i18n.
- Inline quiz blocks via a custom Portable Text block type (native-plugin only).

**Learning engine:**
- Enrollments, per-lesson progress with video resume, per-lesson drip gating (immediate + relative modes), sequential-lesson requirements, free-preview lessons.
- Server-graded quizzes with 4 question types (MCQ, multi-select, true/false, short-text), configurable time limits (hard/soft policy), optional randomization.
- Certificate records with unique verification codes; public `certificate:verify` endpoint.
- Cohorts with capacity hints and CSV email import.
- Multi-instructor course assignment (lead/co/ta) via plugin storage.
- Lesson-level discussions via emdash's built-in comments.

**Admin:**
- React admin pages mounted at `/_emdash/admin/plugins/lms-core/`: teaching dashboard, course detail (7-tab layout), enrollment management, quiz authoring, cohort management, instructor assignments, settings.
- One-click setup wizard that provisions the Courses and Lessons content collections.
- Per-student progress drill-down across all their enrolled courses.

**Integrations:**
- Reuses emdash's passkey/OAuth/magic-link auth; no plugin-side auth surface.
- Site-side routes documented for theme authors: `catalog`, `my-learning`, `curriculum`, `lesson`, `progress:tick`/`complete`, `quiz:start`/`submit`, `certificates:mine`, `certificate:verify`.

**Deferred to v1.1+:** payment integration (Stripe, x402), certificate PDF rendering, site-wide admin analytics UI, standalone theme package (`@emdash/lms-theme`), cohort CSV auto-invite.

**Requires:** `emdash >=0.5.0`, `astro ^6.0.0`, `react ^19.0.0`, Node 20+ or Cloudflare Workers (Dynamic Worker Loader disabled — this plugin runs in trusted/native mode).

**License:** MIT.
```

Emdash peer-dep pinned by T00 at `>=0.5.0` (package.json). Update this range in v1.1+ only if consuming new emdash features that require a newer minimum.

### 17.9 Open implementation questions

Added to §12:

- **Q16.** Package name — see D51 for the resolution.
- **Q17.** Should the plugin ship a minimal starter Astro demo (`demos/simple/`) alongside, so maintainers can smoke-test the full integration? Adds ~0.5 week but catches integration regressions early.
- **Q18.** Test coverage bar: aim for ≥80% on `engine/*` (achievable; pure functions + real SQLite), looser on `admin/*` (React component tests are lower ROI). Agree, or set a single number across the whole package?

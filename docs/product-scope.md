# EmDash Learn product scope

**Status:** Authoritative first-release contract  
**Compatible host target:** EmDash 0.32.0  
**Release order:** Publish the EmDash core principal contract first, then
publish Learn  
**Product:** Course publishing, device and account learning records,
knowledge checks, and privacy-preserving engagement reporting

## Product decision

EmDash Learn extends EmDash with structured learning. It does not implement a
second identity system.

EmDash core owns:

- registration, account recovery, and deployment-specific onboarding;
- email verification and resend;
- passkeys, magic links, external identity, credentials, and sessions;
- global users and roles; and
- the authenticated, minimal principal supplied to plugin route handlers.

EmDash Learn owns:

- Course and Lesson publishing conventions;
- knowledge-check authoring and immutable published revisions;
- anonymous self-check grading and browser-local device progress;
- principal-linked lesson completion and assessment Attempts;
- account data erasure for Learn-owned records; and
- aggregate and verified-account engagement reporting.

Learn does not collect profile or authentication data. No route accepts a
browser-supplied `userId`, `learnerId`, name, email address, phone number, role,
or account claim. Personalized modules accept only the opaque learner identity
derived from EmDash's trusted principal.

## Actors

### Anonymous visitor

Can browse published Courses and Lessons and take self-checks. Lesson
completion and self-check summaries may be saved in that browser through
`DeviceProgressStore`; they are not account records. Anonymous activity
contributes directional aggregate reporting.

### Authenticated learner

Has an EmDash session whose principal is authorized for `content:read`. Can
store monotonic Lesson Completion Facts, import device Lesson completions,
submit server-graded Attempts, list their own Attempts, read their own Course
progress, and erase their Learn-owned account data. Core—not Learn—decides
which onboarding modes and global roles grant that permission.

“Verified learner” and “verified account” in Learn mean an authenticated EmDash
account. They are not claims that one account equals one unique human.

### Editor

Uses EmDash content editing plus Learn's `/checks` interface. Assessment
authoring routes require `content:edit_any`.

### Administrator

Runs setup, views `/reports`, and may invoke maintenance routes.
Administrative routes require `plugins:manage`.

## Module contracts

### Course Publishing

Course Publishing exposes allowlisted projections of published content:

```ts
interface CoursePublishing {
	listCatalog(input: CatalogQuery): Promise<CatalogPage>;
	getCourse(input: CourseLookup): Promise<PublishedCourseDetail | null>;
	getLesson(input: LessonLookup): Promise<PublishedLesson | null>;
}
```

Draft, scheduled, trashed, orphaned, and stale projection records are not
public. Reads recheck authoritative content rather than trusting an index row
alone.

### Assessment

Assessment owns drafts, publication heads, immutable revisions, grading, and
Attempts:

```ts
interface Assessment {
	createDraft(input: DraftCheckInput): Promise<DraftCheck>;
	updateDraft(checkId: string, input: DraftCheckInput): Promise<DraftCheck | null>;
	publish(checkId: string): Promise<PublishedCheckPresentation | null>;
	archive(checkId: string): Promise<boolean>;
	present(input: { courseId: string; checkId: string }): Promise<PublishedCheckPresentation | null>;
	selfGrade(input: CheckSubmission): Promise<CheckResult>;
	submitAttempt(
		learner: VerifiedLearner,
		input: IdempotentCheckSubmission,
	): Promise<AttemptSubmissionResult>;
	listAttempts(
		learner: VerifiedLearner,
		input: { checkId?: string },
	): Promise<PersistedCheckResult[]>;
}
```

Each Draft is authored for exactly one `courseId`. Publishing writes that
Course binding into a new immutable revision and then moves the stable
`checkId` head. Public presentation exposes `courseId`, `checkId`, and the
exact `revisionId`; presentation and grading reject a mismatched Course.
Authenticated submission also verifies that Course is currently published.
Explicit public DTO construction omits correct answers and explanations;
anonymous self-grading may return authored explanations only after submission.

Anonymous self-grading creates no account Attempt. The browser may save its
result in device progress. Every successful public self-grade request emits one
best-effort `check_submitted` observation, classified from the optional Core
principal as anonymous or verified. An authenticated submission is graded on
the server and persists an immutable, learner-keyed Attempt. Attempts retain
revision, score, pass/fail, points, per-question correctness, and server
timestamps, but never submitted answers, authored explanations, or free text.
Storage enforces a unique `(learnerKey, submissionId)` composite. Concurrent
identical retries re-read and return the one durable winner; conflicting reuse
is rejected. The result identifies whether this request recorded the Attempt
so identical authenticated retries emit `check_submitted` only once.

### Learning Record and device progress

The Learning Record owns principal-linked Completion Facts and derived Course
progress:

```ts
interface LearningRecord {
	completeLesson(
		learner: VerifiedLearner,
		input: { lessonId: string; operationId: string },
	): Promise<LessonCompletionResult>;
	getCourseProgress(learner: VerifiedLearner, input: { courseId: string }): Promise<CourseProgress>;
	importDeviceProgress(
		learner: VerifiedLearner,
		input: { courseId: string; lessonIds: string[]; operationId: string },
	): Promise<DeviceImportResult>;
}
```

Completion is monotonic. Percent complete is derived from Completion Facts and
the current published Lesson set; no mutable percentage counter is
authoritative. Storage enforces one immutable Completion Fact per
`(learnerKey, lessonId)`. Concurrent direct completions, retries, and device
imports re-read and return the durable winner rather than producing duplicate
facts or duplicate reporting.

Anonymous state is behind a bounded browser `DeviceProgressStore` with a
`localStorage` adapter. It supports reset, export, and import. After sign-in,
published Lesson IDs may be imported as `device_import` Completion Facts.
Device self-check scores are not promoted to authenticated Attempts.

### Engagement Reporting

Reporting is a separate, best-effort module:

```ts
interface EngagementReporting {
	observe(event: EngagementObservation): Promise<void>;
	query(input: EngagementReportQuery): Promise<EngagementReport>;
	pruneExpired(): Promise<EngagementPruneResult>;
}

interface ActorCount {
	total: number;
	anonymous: number;
	verified: number;
}
```

The fixed observation vocabulary is:

- `course_opened`;
- `lesson_opened`;
- `lesson_completed`;
- `check_opened`; and
- `check_submitted`.

Opens are rate-limited, directional browser observations. Public rate-limit
buckets use only Core's trusted client IP; when no trusted IP is available,
the installation shares one conservative fallback bucket. User-Agent never
creates a separate budget. A successful self-grade request emits one submission
observation; account completion and submission observations are emitted only
for newly durable facts.
Reporting failure is logged and does not fail delivery, grading, or progress.

The browser package exposes typed
`observeCourseOpened(courseId)` and
`observeLessonOpened({ courseId, lessonId })` methods. A consuming site calls
the matching method once after its Course or Lesson page loads. These methods
always resolve, including on transport, validation, rate-limit, or storage
failure; they are directional observations rather than delivery
acknowledgements.

Stored observations contain resource IDs, an event type, UTC timestamps/day,
actor kind, an optional day-scoped keyed actor pseudonym, and redacted
pass/score-band outcomes. They contain no copied name, email, phone, raw IP,
full user agent, submitted answer, or free text.

Reports aggregate retained observations exactly at query time and expose
`calculatedThrough`, captured after the storage read as the report snapshot
watermark. It is not the timestamp of the latest visitor activity. Real
reporting queries return the watermark even when no observations match.
Every event metric—including Course opens, Lesson opens/completions, Check
opens/submissions/passes, and every score band—is an `ActorCount`; `total`
equals `anonymous + verified`.
`verifiedAccountDays` is the sum of distinct authenticated actor pseudonyms
within each UTC day. It is additive across days and is not a cross-day unique
account or unique-person count.

Observations are retained for 90 days. Daily best-effort maintenance deletes
only observations whose `observedAt` is strictly older than the retention
cutoff. Learn deliberately does not compact them into Daily Rollups: Core's
current plugin storage API cannot atomically fence observation ingestion,
write an aggregate, and delete its source rows. Exact bounded raw reporting is
the valid first-release contract.

### Privacy Erasure

`privacy:erase-my-data` derives the learner from the authenticated principal
and deletes:

- their Lesson Completion Facts;
- their persisted assessment Attempts; and
- attributable raw Engagement Observations.

The operation is retry-safe and reports partial category failures. Because
reports are computed from retained observations, successful erasure removes
that attributable activity from subsequent reports. Erasure never deletes
shared Course/Lesson content or anonymous device storage in someone else's
browser.

Raw-observation erasure first enforces the 90-day retention cutoff. It then
recomputes the learner's day-scoped pseudonym for each UTC day intersecting
the retained window and queries those values through the `actorKey` index; it
never scans other learners' retained observations or adds a stable cross-day
reporting identifier. If retention pruning fails, that erasure category fails
closed and is reported for retry.

The browser package exposes
`createLearnBrowserClient(...).eraseMyData()` for authenticated sites. The host
site is responsible for presenting the learner-facing action, confirmation,
success, and partial-failure recovery UX; Learn does not silently erase data or
invent a second account settings surface. A partial failure rejects with a
`LearnBrowserApiError` whose `details` preserve `failedCategories` and the
per-category `deleted` counts returned by the route.

## Setup contract

`setup:run` is a strict no-input (`{}`) administrator route. Server-side setup:

1. probes required Course/Lesson schema semantics;
2. adds compatible missing definitions;
3. verifies the resulting schema;
4. repairs the published content projection; and
5. persists server-derived completion evidence.

`setup:state` reads that evidence. The browser cannot submit completed step IDs.
Incompatible collisions fail closed. Setup and uninstall preserve
administrator-authored Course and Lesson content.

All non-setup product routes are gated until the persisted setup evidence is
compatible with the current contract version.

## Portable Text contract

The canonical block type is `learnKnowledgeCheck`:

```ts
interface LearnKnowledgeCheckBlock {
	_type: "learnKnowledgeCheck";
	courseId: string;
	checkId: string;
}
```

`courseId` provides published Course and reporting context. `checkId` resolves
the current published assessment head. The block does not support `lmsQuiz`,
`quizId`, or a mutable embedded answer key.

Astro consumers import the canonical renderer as
`KnowledgeCheckBlock` from `@emdash/lms-core/astro`; `blockComponents` maps
`learnKnowledgeCheck` to that same component.

## Route surface

The first release uses these route families:

| Access                | Routes                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public                | `catalog`, `course:get`, `lesson:get`                                                                                                                                        |
| Public                | `assessment:present`, `assessment:self-grade`                                                                                                                                |
| Public                | `engagement:observe`                                                                                                                                                         |
| Authenticated learner | `learning:complete-lesson`, `learning:progress`, `learning:import-device-progress`                                                                                           |
| Authenticated learner | `assessment:submit-attempt`, `assessment:attempts`, `privacy:erase-my-data`                                                                                                  |
| Editor                | `assessment:draft-list`, `assessment:draft-create`, `assessment:draft-get`, `assessment:draft-update`, `assessment:draft-delete`, `assessment:publish`, `assessment:archive` |
| Administrator         | `setup:state`, `setup:run`, `reporting:query`                                                                                                                                |

Every personalized operation derives ownership from the core principal and
declares `permission: "content:read"`. There is no caller-controlled identity
override.

## Content model

### Course

- `title`
- `subtitle`
- `description`
- `body`
- `cover_image`
- `difficulty`
- `estimated_hours`

### Lesson

- `title`
- `course` reference
- `order`
- `summary`
- `body`
- `video_url`
- `duration_seconds`

The relationship is Course → Lesson. Topic is not a separate learning
primitive.

## Storage and capability budget

Learn declares plugin-scoped storage for:

- published Course/Lesson projection rows;
- assessment drafts, heads, immutable revisions, and Attempts;
- deterministic Lesson Completion Facts;
- redacted, 90-day Engagement Observations.

Learner ownership and reporting actor keys use installation-keyed digests.
Attempts and Completion Facts use immutable row identities plus storage-level
unique composites for their domain keys. Losers of concurrent uniqueness races
re-read the durable winner because EmDash plugin storage does not promise
transactions or compare-and-swap.

The descriptor requests only `content:read`. Editor and administrator routes
also declare the relevant core permissions. Learn requests no user-write,
role-management, email, phone, SMS, network, or media-write capability.

## Security and privacy invariants

- EmDash core is the only source of authenticated learner identity.
- Learn never creates or mutates global users or roles.
- Learners can read and mutate only their own learning records.
- Public DTOs are explicit allowlists.
- Draft and unpublished content does not leak through errors or projections.
- Published Check Revisions and persisted Attempts are immutable.
- Correct answers do not appear in public presentation.
- Scores and completion timestamps are server-assigned.
- Raw answers and free text are not persisted.
- Public grading and observation use bounded, keyed trusted-IP abuse controls
  with one installation fallback when no trusted IP is available.
- Reporting failure is fail-open for learning operations.
- Anonymous and authenticated account metrics remain distinguishable.
- Account erasure removes attributable facts and observations from subsequent
  reports.

## Explicit non-goals

The first release does not include:

- plugin-owned registration, verification, credentials, sessions, users, or
  roles;
- profile, email, phone, SMS, or password collection;
- enrollment, paid access, commerce, or access gating;
- custom LMS roles or per-Course instructor authorization;
- cohorts, rosters, assignments, certificates, credentials, drip scheduling,
  or proctoring;
- lifecycle marketing; or
- claims that an authenticated account represents one unique person.

## Distribution and release order

Learn is a native/trusted npm plugin because it contributes React admin pages
and an Astro renderer. Marketplace/sandbox distribution is not required for
the first release.

The release sequence is mandatory:

1. EmDash publishes 0.32.0 with the tested authenticated plugin-route
   principal.
2. Learn updates its development dependency and lockfile to that published
   version.
3. Learn passes unit, integration, E2E, build, pack, and temporary-consumer
   validation without sibling links or overrides.
4. Learn publishes its prerelease, validates the demo against installed
   packages, and then publishes stable.

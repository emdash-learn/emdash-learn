# EmDash Learn 0.1 product scope

Status: authoritative for the first public release.

## Product statement

EmDash Learn turns published EmDash content into a self-guided Course
experience. Editors author Courses, Lessons, and Knowledge Checks. Visitors
read published material, grade self-checks, and retain lightweight progress in
their own browser. Administrators see anonymous aggregate engagement.

Version 0.1 targets the published EmDash 0.31 plugin API. It is useful without
claiming capabilities that Core does not yet expose to plugins.

## Included

### Course and Lesson content

- `setup:run` additively converges the Course and Lesson content schemas and
  the published-content projection.
- Public routes expose allowlisted projections of published Courses and
  Lessons only.
- Draft, scheduled, trashed, orphaned, and stale content is never returned by
  public learning routes.
- Setup preserves compatible administrator-authored fields and content.

### Knowledge Checks

- Editors can create, list, read, update, delete, publish, and archive
  Course-bound Knowledge Check drafts.
- Published revisions are immutable.
- Public presentation omits answer keys and authored correctness metadata.
- Public self-grading is deterministic and targets the exact presented
  `revisionId`.
- Supported question types and validation are defined by the assessment
  schemas in the package.
- Raw submitted answers and free text are not persisted.
- The canonical Portable Text block is `learnKnowledgeCheck` with required
  `courseId` and `checkId`.

### Browser-local progress

- The browser client stores completed Lesson IDs and the latest self-check
  result per Knowledge Check.
- Progress is bounded, schema-validated, and isolated under
  `emdash-learn:device-progress:v1`.
- Corrupt or unsupported stored data is ignored safely.
- The store supports reading, resetting, exporting, and importing its own
  versioned snapshot.
- Browser-local progress is not an account record, does not synchronize
  between browsers, and may disappear when site storage is cleared.

### Anonymous engagement reporting

- Public observation routes accept only Course, Lesson, and Knowledge Check
  open events from a fixed schema.
- Each successful public self-grade emits one anonymous submission
  observation after grading.
- Reporting failure is outside the content and grading success paths.
- Public observation and grading routes use bounded abuse controls.
- Administrators can query an exact half-open UTC range, optionally filtered
  by Course.
- Reports show event totals, pass rate, score bands, and a
  `calculatedThrough` snapshot watermark.
- Event totals are directional activity, not unique visitors, users, sessions,
  or people.
- Redacted observations are retained for at most 90 days and aggregated
  exactly at query time.
- Daily best-effort pruning deletes only observations strictly older than the
  retention cutoff.

### Administration and distribution

- Native React admin pages cover overview, Knowledge Check authoring,
  reporting, and setup.
- The package exports plugin metadata, sandbox routes, admin pages, the browser
  client, and the canonical Astro block renderer.
- The package declares compatibility with EmDash `^0.31.1`, Astro `^7.1.3`,
  React/React DOM `^19.0.0`, and Node `>=22.12.0`.

## Privacy boundary

Learn 0.1 does not request or store:

- name, email address, phone number, password, or verification code;
- EmDash user or role identifiers;
- caller-supplied learner identity;
- raw answers or free-text responses;
- raw IP addresses or full user agents; or
- account-linked learning history.

Request metadata may be transformed into a bounded keyed fingerprint for
short-lived abuse control. That value is not copied into reports.

## Explicitly excluded

- signup, sign-in, email verification, resend, account recovery, credentials,
  sessions, users, and roles;
- account-linked Lesson completion or Course progress;
- server-side Knowledge Check Attempts or learner history;
- synchronization or device-to-account progress import;
- certificates, credentials, enrollment, cohorts, assignments, due dates, and
  instructor grading;
- learner-profile reporting, unique-user analytics, and cross-device identity;
- learner privacy-erasure routes for data this release does not collect;
- billing, payments, messaging, and notifications.

The plugin must not emulate missing Core identity with a request header,
browser-generated ID, email address, or caller-supplied user identifier.

## Route contract

| Audience                         | Routes                                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public                           | `courses:list`, `courses:get`, `lessons:get`                                                                                                                                 |
| Public                           | `assessment:present`, `assessment:self-grade`                                                                                                                                |
| Public                           | `engagement:observe`                                                                                                                                                         |
| Editor (`content:edit_any`)      | `assessment:draft-list`, `assessment:draft-create`, `assessment:draft-get`, `assessment:draft-update`, `assessment:draft-delete`, `assessment:publish`, `assessment:archive` |
| Administrator (`plugins:manage`) | `reporting:query`, `setup:state`, `setup:run`                                                                                                                                |

All routes are POST-only under the EmDash plugin-route transport. Public
content and assessment routes validate published Course context before
returning data.

## Storage contract

| Collection                | Purpose                                        |
| ------------------------- | ---------------------------------------------- |
| `course_content_index`    | Published Course and Lesson projection         |
| `assessment_drafts`       | Mutable editor drafts                          |
| `assessment_revisions`    | Immutable published revisions                  |
| `assessment_heads`        | Current published revision per Knowledge Check |
| `engagement_observations` | Redacted, retained anonymous events            |

There is no Attempt, learner, Lesson-completion, account, profile, or role
collection in the 0.1 plugin descriptor.

## Future account track

Account-linked progress remains valuable but is not a release blocker.
EmDash's official dependency is
[issue #812](https://github.com/emdash-cms/emdash/issues/812), which proposes
exposing authenticated `user` information on plugin `RouteContext`; existing
Core work is tracked in
[pull request #1947](https://github.com/emdash-cms/emdash/pull/1947).

After that contract ships in a published Core release, a later Learn version
may adapt the preserved account candidate to official `ctx.user.id` semantics,
re-run privacy and concurrency review, and introduce account routes through a
separate versioned change. Version 0.1 must not depend on the local prototype
contract.

## Release acceptance

The release is acceptable when:

1. the declared routes and storage match this document;
2. package metadata targets the published EmDash 0.31 line;
3. typecheck, lint, format, unit, integration, build, and anonymous E2E gates
   pass;
4. the demo builds against the packed artifact;
5. the tarball exposes only intended public package files; and
6. the same gates pass from a clean checkout on Node 22.

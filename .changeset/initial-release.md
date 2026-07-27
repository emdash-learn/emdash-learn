---
"@emdash/lms-core": major
---

Introduce EmDash Learn, an open-source Course publishing and learning-record
plugin for EmDash.

- Add convergent, server-verified `setup:run` provisioning for Course and
  Lesson content collections and the published-content projection.
- Expose allowlisted, published-only catalog, Course, and Lesson routes.
- Add Course-bound, editor-authored Knowledge Check drafts, four question
  types, immutable published revisions, archive, redacted presentation, and
  deterministic grading.
- Add the `learnKnowledgeCheck` Portable Text block with required `courseId`
  and `checkId` fields, plus the canonical `KnowledgeCheckBlock` Astro export.
- Save anonymous Lesson completion and self-check summaries in bounded
  browser-local device progress without creating an account record.
- Derive authenticated learner ownership exclusively from the EmDash route
  principal, with immutable concurrency-safe Lesson Completion Facts, device
  Lesson import, immutable concurrency-safe server-graded Attempts, own
  progress, and own Attempt history.
- Add best-effort engagement reporting with directional anonymous activity,
  `{ total, anonymous, verified }` actor counts for every event metric and
  score band, exact retained-event aggregation, freshness, and
  `verifiedAccountDays`.
- Retain redacted observations for 90 days and run daily best-effort pruning
  without relying on a non-transactional aggregate rollup.
- Add principal-owned privacy erasure for Lesson Completion Facts, Attempts,
  and attributable raw observations, exposed to sites through the browser
  client's `eraseMyData()` method.
- Add exact static admin pages for overview, Knowledge Check authoring,
  reporting, and setup.
- Keep registration, verification, credentials, sessions, users, roles, and
  profile data in EmDash core; Learn collects no name, email address, phone
  number, password, or verification code.

Requires EmDash `^0.32.0`, Astro `^6.0.0`, React/React DOM `^19.0.0`, and Node
22.12 or newer. EmDash 0.32.0 must publish the authenticated plugin-route
principal before this release.
